import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@liyuan/agent-runtime";
import { DIRECTOR_ROLES } from "../src/stage/agent-director.ts";
import { StageEngine, type StageEvents, type StageStreamFn } from "../src/stage/engine.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { SUPPLEMENTARY_ENTRY_TYPE, SUPPLEMENTARY_PROTOCOL, normalizeSupplementaryText, supplementaryHash, supplementaryInput, parseSupplementaryResponse } from "../src/stage/supplementary.ts";
import { settlementRetry } from "../src/stage/settlement-retry.ts";
import { supplementaryMvuInput } from "../server/wire.ts";

const AUTHOR = "  \n<content>The companion opens the observatory log.</content>\n\n  ";
const SUPPLEMENT = "<scene_sidecar>SUPPLEMENT_ONLY_SENTINEL: possible next observations.</scene_sidecar>";
const FORMAT = "After the story, output a <scene_sidecar>possible next observations</scene_sidecar> block.";
const DISABLED = "DISABLED_SUPPLEMENTARY_MATERIAL";
const NATIVE_VARIABLES = "Native protocol: output <UpdateVariable>…</UpdateVariable> after the reply";
// A delivered variable update whose values do not change is a legal artifact.
const NOOP_PATCH = "<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// Mirrors the local generation-mode-engine fixture: real assembly/tree/settlement,
// synthetic models only. Gates intentionally allow a provider to finish after abort.
function fixture(mode: "direct" | "director", options: {
	events?: StageEvents;
	gate?: (model: string, supplementary: boolean, context: Parameters<StageStreamFn>[1]) => Promise<void>;
	supplement?: string;
	authorDraft?: string;
	nativeSelection?: number[];
 rawSupplement?:string;
 /** Per supplementary request (0-based, repairs included); undefined falls back to the default response. */
 rawSupplementAt?:(index:number)=>string|undefined;
 /** Variable-update item the default response adds when the frozen input demands one; false omits it. */
 variables?:string|false;
	database?:boolean;
  databaseBefore?:()=>void;
 tavernAfter?:(entryId:string)=>Promise<void>;
 turns?:number;
} = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-supplementary-engine-"));
	writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: {
		name: "Synthetic companion", description: "Observatory keeper", first_mes: "The log is here.",
		character_book: { entries: [
			{ id: 1, keys: [], constant: true, enabled: true, content: FORMAT },
			{ id: 2, keys: [], constant: true, enabled: false, content: DISABLED },
			...(options.nativeSelection ? [
				{ id: 3, keys: [], constant: true, enabled: true, content: "UNSELECTED_MATERIAL: output <unselected>…</unselected>" },
				{ id: 4, keys: ["log"], constant: false, enabled: true, content: "ACTIVATED_MATERIAL: output <activated_note>…</activated_note> at the end" },
				{ id: 5, keys: [], constant: true, enabled: true, content: NATIVE_VARIABLES },
				{ id: 6, keys: ["never-triggered-synthetic-key"], constant: false, enabled: true, content: "UNACTIVATED_MATERIAL".repeat(30000) },
			] : []),
		] },
	} }));
	mkdirSync(join(cwd, ".liyuan"));
	cpSync(new URL("../skills/", import.meta.url), join(cwd, "skills"), { recursive: true });
	const steps = ["literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "scribe"];
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({
		card: "card.json", generationMode: mode, literaryWorldEnabled: false, literaryEcologyEnabled: true,
		stepModels: Object.fromEntries(steps.map(id => [id, { provider: "faux", id }])),
	}));
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const consult = (phase: keyof typeof DIRECTOR_ROLES) => ({ calls: [{ name: "consult_experts", args: {
		tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "Check synthetic materials." })),
	} }] });
 const draft = options.authorDraft ?? AUTHOR;
  const script: Array<{ text?: string; calls?: Array<{ name: string; args?: object }> }> = mode === "direct" ? [{ text: draft }] : [
		consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] },
		{ text: draft }, consult("review"), { calls: [{ name: "finalize" }] },
	];
 const firstScript=structuredClone(script);
 for(let turn=1;turn<(options.turns??1);turn++)script.push(...structuredClone(firstScript));
	const requests: Array<{ model: string; supplementary: boolean; context: Parameters<StageStreamFn>[1] }> = [];
	let supplementaryCalls = 0;
	const streamFn: StageStreamFn = (model, context) => {
		// The protocol may carry a computed variable-update suffix; repairs append the repair skill.
		const supplementary = String(context.systemPrompt ?? "").startsWith(SUPPLEMENTARY_PROTOCOL);
		requests.push({ model: model.id, supplementary, context: structuredClone(context) });
		let response: (typeof script)[number];
		if (supplementary) {
			const demandsVariables = JSON.stringify(context.messages).includes(NATIVE_VARIABLES) && options.variables !== false;
			const items = [
				...(normalizeSupplementaryText(options.supplement ?? SUPPLEMENT) ? [{ source: 'entries.0', requirement: FORMAT, text: options.supplement ?? SUPPLEMENT }] : []),
				// Mislabelled on purpose: the quoted requirement rebinds it to the single native source.
				...(demandsVariables ? [{ source: 'entries.0', requirement: NATIVE_VARIABLES, text: options.variables || NOOP_PATCH }] : []),
			];
			response = { text: options.rawSupplementAt?.(supplementaryCalls++) ?? options.rawSupplement ?? JSON.stringify({ version: 2, narrative: null, items }) };
		}
		else if (model.id === "writer") {
			assert.ok(script.length, "supplementary requests must not consume the author script");
			response = script.shift()!;
		} else if (model.id === "scribe") response = { text: '{"patch":{"location":"Observatory"}}' };
		else if (model.id === "literaryDirector") response = { text: '{"scenePressure":"Existing task","candidateBeats":["Check the log"]}' };
		else response = { text: '{"summary":"Synthetic report","facts":[],"inferences":[],"candidates":[],"issues":[],"actors":[],"occurrences":[]}' };
		const message: any = { role: "assistant", content: response.calls
			? response.calls.map((call, index) => ({ type: "toolCall", id: `call-${requests.length}-${index}`, name: call.name, arguments: call.args ?? {} }))
			: [{ type: "text", text: response.text ?? "" }], stopReason: response.calls ? "toolUse" : "stop", usage: { input: 10, output: 10 } };
		return { async *[Symbol.asyncIterator]() {
			await options.gate?.(model.id, supplementary, context);
			if (response.text) yield { type: "text_delta", delta: response.text };
			yield { type: "done", message };
		}, async result() { return message; } };
	};
	const model = { id: "writer", provider: "faux", maxTokens: 10000 };
	const engine = new StageEngine({ cwd, getSessionManager: () => sm as never, getModel: () => model,
		findModel: (provider, id) => ({ ...model, provider, id }), getAuth: async () => ({}), streamFn, events: options.events,
  ...(options.database?{databasePluginMemory:{enabled:()=>true,before:async(userInput:string)=>{options.databaseBefore?.();return {userInput,worldbookEntries:[]};},after:async()=>{},recentHistoryMessages:()=>12}}:{}),
		...(options.nativeSelection ? { tavernPlugins: { enabled: () => true,
			before: async packet => ({ ...packet, retainedWorldbookIndices: options.nativeSelection }), after: async (entryId: string) => { await options.tavernAfter?.(entryId); } } } : {}) });
	return { cwd, sm, engine, requests, cleanup() { engine.abort(); rmSync(cwd, { recursive: true, force: true }); } };
}

const branch = (sm: SessionManager) => sm.getBranch() as any[];
const author = (sm: SessionManager) => branch(sm).find(entry => entry.message?.role === "assistant");
const receipts = (sm: SessionManager) => branch(sm).filter(entry => entry.customType === SUPPLEMENTARY_ENTRY_TYPE);
const frozenAuthor = (message: any) => {
	// Background request diagnostics grow independently of the saved author/facts.
	const { rpModelDiagnostics, ...details } = message.details;
	return JSON.stringify({ ...message, details });
};

for(const mode of ['direct','director'] as const){
 test(`${mode}: manual recovery finds failed A behind successful B and never repeats complete delivery`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let fail=true;
  const f=fixture(mode,{turns:2,gate:async(_model,supplementary)=>{if(supplementary&&fail)throw Error('HTTP 401 synthetic failure');}});
  try{
   await f.engine.performTurn('Synthetic turn A.');const a=author(f.sm),aDraft=frozenAuthor(a.message);
   assert.equal(receipts(f.sm).at(-1).data.status,'failed');
   fail=false;await f.engine.performTurn('Synthetic turn B.');
   const b=branch(f.sm).filter(e=>e.message?.role==='assistant').at(-1),bDraft=frozenAuthor(b.message);
   assert.notEqual(a.id,b.id);assert.equal(receipts(f.sm).at(-1).data.sourceEntryId,b.id);
   const count=f.requests.length;
   assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(f.requests.length,count+1);
   assert.equal(receipts(f.sm).at(-1).data.sourceEntryId,a.id);assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.equal(frozenAuthor(a.message),aDraft);assert.equal(frozenAuthor(b.message),bDraft);
   await f.engine.retryPendingSettlement();assert.equal(f.requests.length,count+1);
  }finally{f.cleanup();}
 });
 for(const stale of ['cancel','branch'] as const)test(`${mode}: ancestor supplementary recovery rejects late ${stale}`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let state='fail';const started=deferred(),release=deferred();
  const f=fixture(mode,{turns:2,gate:async(_model,supplementary)=>{
   if(!supplementary)return;if(state==='fail')throw Error('HTTP 401 synthetic failure');if(state==='block'){started.resolve();await release.promise;}
  }});
  try{
   await f.engine.performTurn('Synthetic turn A.');const a=author(f.sm);state='success';await f.engine.performTurn('Synthetic turn B.');
   const aCount=receipts(f.sm).filter(e=>e.data.sourceEntryId===a.id).length;state='block';
   const retry=f.engine.retryPendingSettlement();await started.promise;
   if(stale==='cancel')f.engine.abort();else f.sm.branch(branch(f.sm).find(e=>e.message?.role==='user').id);
   release.resolve();assert.ok((await retry).error);
   const all=(f.sm.getEntries() as any[]).filter(e=>e.customType===SUPPLEMENTARY_ENTRY_TYPE&&e.data.sourceEntryId===a.id);
   assert.equal(all.length,aCount+1);assert.equal(all.at(-1).data.status,'pending');
  }finally{release.resolve();f.cleanup();}
 });
 test(`${mode}: missing legacy selection is explicitly unreconstructable without a request`,async()=>{
  const f=fixture(mode);
  try{
   await f.engine.performTurn('Synthetic turn A.');
   const old={...receipts(f.sm).at(-1).data,version:1,status:'failed'};delete old.materialView;
   f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,old);f.sm.flush();const count=f.requests.length;
   assert.match((await f.engine.retryPendingSettlement()).error??'',/selection provenance is unavailable/);
   assert.equal(f.requests.length,count);assert.equal(receipts(f.sm).at(-1).data.status,'failed');
  }finally{f.cleanup();}
 });
 test(`${mode}: unreconstructable ancestor cannot starve another pending source`,async()=>{
  const f=fixture(mode,{turns:2});
  try{
   await f.engine.performTurn('Synthetic turn A.');const a=author(f.sm),aReceipt=receipts(f.sm).at(-1).data;
   await f.engine.performTurn('Synthetic turn B.');const bReceipt=receipts(f.sm).at(-1).data;
   const legacy={...aReceipt,version:1,status:'failed'};delete legacy.materialView;
   f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,legacy);
   f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,{...bReceipt,status:'pending'});f.sm.flush();
   const count=f.requests.length,result=await f.engine.retryPendingSettlement();
   assert.match(result.error??'',/selection provenance is unavailable/);
   assert.equal(f.requests.length,count+1);
   assert.equal(receipts(f.sm).at(-1).data.sourceEntryId,bReceipt.sourceEntryId);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.equal(receipts(f.sm).filter(e=>e.data.sourceEntryId===a.id).at(-1).data.status,'failed');
  }finally{f.cleanup();}
 });
}

for (const mode of ["direct", "director"] as const) {
 test(`${mode}: unstructured second narrative is rejected without changing saved author`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});
  const f=fixture(mode,{rawSupplement:'<content>A second story must never be appended.</content>'});
  try{
   await f.engine.performTurn('Continue the synthetic log.');
   assert.equal(receipts(f.sm).at(-1).data.status,'failed');
   assert.equal(author(f.sm).message.details.rpAuthorDraft,AUTHOR);
   assert.equal(f.requests.filter(r=>r.supplementary).length,4);
  }finally{f.cleanup();}
 });
 test(`${mode}: explicit regeneration replaces legacy complete append-only with exact receipt CAS`,async()=>{
  const f=fixture(mode);
  try{
   await f.engine.performTurn('Continue the synthetic log.');
   const saved=author(f.sm),snapshot=frozenAuthor(saved.message),current=receipts(f.sm).at(-1).data;
   const oldInput=supplementaryInput(loadStageMaterials(f.cwd),saved.message.details.rpNarrative,AUTHOR,1);
   const legacy={...current,version:1,materialHash:oldInput.materialHash,text:'<content>Synthetic wrong legacy continuation</content>'};
   delete legacy.frozenInput;delete legacy.response;
   f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,legacy);f.sm.flush();
   const count=f.requests.length,binding=supplementaryHash(JSON.stringify(legacy));
   assert.ok((await f.engine.regenerateSupplementary('sibling',saved.id,binding)).error);
   assert.ok((await f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,'stale')).error);
   assert.equal(f.requests.length,count);
   assert.equal((await f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,binding)).error,undefined);
   assert.equal(receipts(f.sm).at(-1).data.version,4);
   assert.equal(receipts(f.sm).at(-1).data.text,SUPPLEMENT);
   assert.ok(receipts(f.sm).some(e=>e.data.text===legacy.text));
   assert.equal(frozenAuthor(saved.message),snapshot);
   assert.ok((await f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,binding)).error);
  }finally{f.cleanup();}
 });
 test(`${mode}: database activated keyword format and card examples reach frozen supplementary input`,async()=>{
  const notices:string[]=[];
  const f=fixture(mode,{database:true,events:{onNotify:(_level,text)=>{notices.push(text);},onActivity:text=>{notices.push(text);}}});
  try{
   const path=join(f.cwd,'card.json'),card=JSON.parse(readFileSync(path,'utf8'));
   card.data.mes_example='Synthetic example: output <example_format>…</example_format> after each reply';
   card.data.character_book.entries.push({id:8,keys:['native-trigger'],constant:false,enabled:true,content:'ACTIVE_NATIVE_FORMAT: output <active_native>…</active_native>'},
    {id:9,keys:['absent-trigger'],constant:false,enabled:true,content:'INACTIVE_NATIVE_FORMAT: output <inactive_native>…</inactive_native>'});
   writeFileSync(path,JSON.stringify(card));
   const outcome=await f.engine.performTurn('native-trigger');
   assert.ok(receipts(f.sm).length,JSON.stringify({outcome,notices}));
   const delivery=receipts(f.sm).at(-1).data,input=JSON.parse(delivery.frozenInput);
   assert.equal(delivery.status,'complete');
   assert.equal(input.card.mesExample,card.data.mes_example);
   assert.ok(input.entries.some((e:any)=>e.content.startsWith('ACTIVE_NATIVE_FORMAT')));
   assert.ok(!input.entries.some((e:any)=>e.content.startsWith('INACTIVE_NATIVE_FORMAT')||e.content===DISABLED));
   const count=f.requests.length;await f.engine.retryPendingSettlement();assert.equal(f.requests.length,count);
  }finally{f.cleanup();}
 });
 for (const failures of [1, 4]) {
  test(`${mode}: supplementary network failure ${failures === 1 ? "automatically recovers" : "exhausts bounded retries then manually recovers"}`, { timeout: 15000 }, async t => {
   const wait = t.mock.method(settlementRetry, "wait", async (signal: AbortSignal) => { signal.throwIfAborted(); });
   let attempts = 0, snapshot = "";
   const f = fixture(mode, { gate: async (_model, supplementary) => {
    if (supplementary && ++attempts <= failures) throw new Error(failures === 1 ? "UND_ERR_CONNECT_TIMEOUT" : "ETIMEDOUT");
   }, events: { onAuthorReady: () => { snapshot = frozenAuthor(author(f.sm).message); } } });
   try {
    await f.engine.performTurn("Continue the synthetic log.", { generationMode: mode });
    assert.equal(attempts, failures === 1 ? 2 : 4);
    assert.equal(receipts(f.sm).at(-1).data.status, failures === 1 ? "complete" : "failed");
    assert.equal(wait.mock.callCount(), failures === 1 ? 1 : 3);
    assert.equal(frozenAuthor(author(f.sm).message), snapshot);
    const originalInput = (f.requests.find(request => request.supplementary)!.context.messages[0] as any).content;
    assert.equal((await f.engine.retryPendingSettlement()).error, undefined);
    assert.equal(attempts, failures === 1 ? 2 : 5);
    assert.equal(receipts(f.sm).at(-1).data.status, "complete");
    assert.equal(receipts(f.sm).at(-1).data.text, SUPPLEMENT);
    assert.equal(frozenAuthor(author(f.sm).message), snapshot);
    for (const request of f.requests.filter(request => request.supplementary))
     assert.deepEqual((request.context.messages[0] as any).content, originalInput);
    assert.equal(f.requests.filter(request => request.model === "writer" && !request.supplementary).length, mode === "direct" ? 1 : 6);
    const count = f.requests.length;
    await f.engine.retryPendingSettlement();
    assert.equal(f.requests.length, count);
   } finally { f.cleanup(); }
  });
 }
}

test('host-owned ancillary schema rejects narrative fields and unbound requirements, preserving arbitrary formats',()=>{
 const input=JSON.stringify({card:{mesExample:'Render an arbitrary ancillary artifact.'},entries:[],preset:[]});
 for(const raw of ['plain continuation',JSON.stringify({version:2,narrative:'continued story',items:[]}),JSON.stringify({version:2,narrative:null,items:[{source:'card.mesExample',requirement:'invented',text:'anything'}]})])assert.throws(()=>parseSupplementaryResponse(raw,input),/schema/);
 for(const text of ['<new-unseen-tag>Auxiliary fiction</new-unseen-tag>','{"custom":[1,2]}','## Arbitrary Markdown\nDetails','<content>Card-defined auxiliary container</content>']){
  const response={version:2,narrative:null,items:[{source:'card.mesExample',requirement:'arbitrary ancillary artifact',text}]};
  assert.equal(parseSupplementaryResponse(JSON.stringify(response),input).text,text);
 }
});

test('ancillary schema rebinds a mislabelled source only to the single source quoting the requirement, and accepts one closed JSON fence',()=>{
 const input=JSON.stringify({card:{},entries:[{name:'other',content:'unrelated rules'},{name:'event',content:'Append PATCH-A to the update list.'},{name:'dup',content:'shared phrase'},{name:'dup2',content:'shared phrase'}],preset:[]});
 const item={source:'entries.0',requirement:'Append PATCH-A',text:'<UpdateVariable>PATCH-A</UpdateVariable>'};
 const parsed=parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[item]}),input);
 assert.equal(parsed.text,item.text);assert.deepEqual((parsed.response as any).items[0].source,'entries.1');
 // The persisted response must re-validate unchanged (wire projection re-parses it).
 assert.equal(parseSupplementaryResponse(JSON.stringify(parsed.response),input).text,item.text);
 assert.throws(()=>parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[{...item,requirement:'shared phrase'}]}),input),/schema/,'ambiguous quote is not guessed');
 assert.throws(()=>parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[{...item,source:'entries.9',requirement:'not quoted anywhere'}]}),input),/schema/);
 assert.equal(parseSupplementaryResponse('```json\n{"version":2,"narrative":null,"items":[]}\n```',input).text,'');
 assert.throws(()=>parseSupplementaryResponse('Here you go:\n```json\n{"version":2,"narrative":null,"items":[]}\n```',input),/schema/,'prose around the fence stays narrative');
});

for(const mode of ['direct','director'] as const){
 test(`${mode}: independent regeneration is busy and settling without another author-ready event`,async()=>{
  const started=deferred(),release=deferred();let block=false,authorReady=0;
  const f=fixture(mode,{events:{onAuthorReady:()=>{authorReady++;}},gate:async(_model,supplementary)=>{if(block&&supplementary){started.resolve();await release.promise;}}});
  try{
   await f.engine.performTurn('Continue the synthetic log.');
   const saved=author(f.sm),binding=supplementaryHash(JSON.stringify(receipts(f.sm).at(-1).data));
   assert.equal(authorReady,1);block=true;
   const pending=f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,binding);
   await started.promise;
   assert.equal(f.engine.isStreaming,true);assert.equal(f.engine.isSettling,true);assert.equal(authorReady,1);
   assert.ok((await f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,binding)).error);
   release.resolve();assert.equal((await pending).error,undefined);
   assert.equal(f.engine.isStreaming,false);assert.equal(f.engine.isSettling,false);assert.equal(authorReady,1);
  }finally{release.resolve();f.cleanup();}
 });
 test(`${mode}: database recovery reuses exact native activation without recall or disabled sources`,async()=>{
  const started=deferred(),release=deferred();let first=true;
  let recalls=0;
  const f=fixture(mode,{database:true,databaseBefore:()=>{recalls++;},gate:async(_model,supplementary)=>{if(supplementary&&first){first=false;started.resolve();await release.promise;}}});
  const path=join(f.cwd,'card.json'),card=JSON.parse(readFileSync(path,'utf8'));
  card.data.character_book.entries.push({id:8,keys:['native-trigger'],constant:false,enabled:true,content:'FROZEN_NATIVE_FORMAT: output <frozen_native>…</frozen_native>'});
  writeFileSync(path,JSON.stringify(card));
  const turn=f.engine.performTurn('native-trigger');
  try{
   await started.promise;f.engine.abort();release.resolve();await turn;
   const frozen=receipts(f.sm).at(-1).data.frozenInput;
   assert.ok(frozen.includes('FROZEN_NATIVE_FORMAT'));
   const requests=f.requests.filter(r=>r.model==='writer'&&!r.supplementary).length;
   assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.equal(receipts(f.sm).at(-1).data.frozenInput,frozen);
   assert.equal(f.requests.filter(r=>r.model==='writer'&&!r.supplementary).length,requests);
   assert.equal(recalls,1);
  }finally{release.resolve();await turn;f.cleanup();}
 });
  test(`${mode}: pending legacy receipt migrates only after verifying old material hash`,async()=>{
  const f=fixture(mode);
  try{
   await f.engine.performTurn('Continue the synthetic log.');
   const saved=author(f.sm),current=receipts(f.sm).at(-1).data;
   const old=supplementaryInput(loadStageMaterials(f.cwd),saved.message.details.rpNarrative,AUTHOR,1);
   const legacy={...current,version:1,status:'failed',materialHash:old.materialHash};delete legacy.frozenInput;delete legacy.response;
   f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,legacy);f.sm.flush();
   assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(receipts(f.sm).at(-1).data.version,4);
   assert.equal(JSON.parse(receipts(f.sm).at(-1).data.frozenInput).card.mesExample,undefined,'v3 only freezes requirement material');
  }finally{f.cleanup();}
  });
  test(`${mode}: v3 pending receipt verifies its old opening-tag input before migrating to paired-tag v4`,async()=>{
   const draft=AUTHOR+'<scene_sidecar>unfinished';
   const f=fixture(mode,{authorDraft:draft});
   try{
    await f.engine.performTurn('Synthetic turn.');
    const saved=author(f.sm),current=receipts(f.sm).at(-1).data;
    const old=supplementaryInput(loadStageMaterials(f.cwd),saved.message.details.rpNarrative,draft,3);
    assert.equal(JSON.parse(old.userText).entries.length,0);
    f.sm.appendCustomEntry(SUPPLEMENTARY_ENTRY_TYPE,{...current,version:3,status:'pending',materialHash:old.materialHash,frozenInput:old.userText});f.sm.flush();
    const calls=f.requests.filter(r=>r.supplementary).length;
    assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
    assert.equal(f.requests.filter(r=>r.supplementary).length,calls+1);
    assert.equal(receipts(f.sm).at(-1).data.version,4);
    assert.equal(JSON.parse(receipts(f.sm).at(-1).data.frozenInput).entries.length,1);
   }finally{f.cleanup();}
  });
}

for(const mode of ['direct','director'] as const){
 test(`${mode}: raw empty terminal is failure, only structured empty items mean skipped`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});
  const f=fixture(mode,{rawSupplement:''});
  try{await f.engine.performTurn('Continue the synthetic log.');assert.equal(receipts(f.sm).at(-1).data.status,'failed');assert.equal(f.requests.filter(r=>r.supplementary).length,4);}finally{f.cleanup();}
 });
 for(const stale of ['cancel','branch','card'] as const){
 test(`${mode}: explicit supplementary regeneration rejects late ${stale}`,async()=>{
  const started=deferred(),release=deferred();let block=false;
  const f=fixture(mode,{gate:async(_model,supplementary)=>{if(supplementary&&block){started.resolve();await release.promise;}}});
  try{
   await f.engine.performTurn('Continue the synthetic log.');
   const saved=author(f.sm),snapshot=frozenAuthor(saved.message),binding=supplementaryHash(JSON.stringify(receipts(f.sm).at(-1).data));
   block=true;const retry=f.engine.regenerateSupplementary(f.sm.getSessionId(),saved.id,binding);
   await started.promise;
   if(stale==='cancel')f.engine.abort();
   if(stale==='branch')f.sm.branch(branch(f.sm).find(e=>e.message?.role==='user').id);
   if(stale==='card')writeFileSync(join(f.cwd,'liyuan.config.json'),JSON.stringify({card:'different.json'}));
   release.resolve();const result=await retry;
   assert.ok(result.error);assert.equal(frozenAuthor(saved.message),snapshot);
   const all=(f.sm.getEntries() as any[]).filter(e=>e.customType===SUPPLEMENTARY_ENTRY_TYPE);
   assert.equal(all.filter(e=>e.data.status==='complete').length,1);
  }finally{release.resolve();f.cleanup();}
 });
 }
}

for (const mode of ["direct", "director"] as const) {
	test(`${mode}: unfinished supplementary container cannot block author-ready or rewrite the original`, async () => {
		const draft = AUTHOR + '\n<scene_sidecar>Partial optional delivery with an unmatched “quote';
		let ready = false;
		const f = fixture(mode, { authorDraft: draft, events: { onAuthorReady: () => { ready = true; } } });
		try {
			await f.engine.performTurn("Continue the synthetic log.", { generationMode: mode });
			const message = author(f.sm).message;
			assert.equal(ready, true);
			assert.equal(message.details.rpAuthorDraft, draft);
			assert.equal(message.details.rpNarrative, "The companion opens the observatory log.");
			assert.equal(message.details.rpGenerationWorkflow.recovery, undefined);
			// An opening tag is not a delivered paired artifact; repair remains independent of the author.
			assert.equal(receipts(f.sm).at(-1).data.status, "complete");
			assert.equal(f.requests.filter(r => r.supplementary).length, 1);
			assert.equal(f.requests.filter(r => r.model === "writer" && !r.supplementary).length, mode === "direct" ? 1 : 6);
		} finally { f.cleanup(); }
	});
	test(`${mode}: supplementary ready is flushed before slow ecology finishes; author and facts stay frozen`, { timeout: 15000 }, async () => {
		const ecology = deferred(), ecologyStarted = deferred(), ready = deferred(), authorReady = deferred();
		let ended = false, snapshot = "", readyCount = 0;
		const f = fixture(mode, { gate: async (model, supplementary, context) => {
			if (model === "ecologyRuntime" && !supplementary && JSON.stringify(context.messages).includes('aftermath')) { ecologyStarted.resolve(); await ecology.promise; }
		}, events: {
			onAuthorReady: () => { snapshot = frozenAuthor(author(f.sm).message); authorReady.resolve(); },
			onSupplementaryReady: info => {
				readyCount++;
				assert.equal(info.entryId, author(f.sm).id);
				assert.equal(receipts(f.sm).at(-1).data.status, "complete");
				assert.ok(readFileSync(f.sm.getSessionFile()!, "utf8").includes(SUPPLEMENT_ONLY_SENTINEL));
				ready.resolve();
			},
			onTurnEnd: () => { ended = true; },
		} });
		// Use a distinct sentinel to verify persistence without parsing private records.
		const SUPPLEMENT_ONLY_SENTINEL = "SUPPLEMENT_ONLY_SENTINEL";
		const turn = f.engine.performTurn("Continue the synthetic log.", { generationMode: mode });
		try {
			await Promise.all([authorReady.promise, ready.promise]);
			await ecologyStarted.promise;
			assert.equal(ended, false);
			assert.equal(f.engine.isSettling, true);
			assert.equal(frozenAuthor(author(f.sm).message), snapshot);
			assert.equal(author(f.sm).message.details.rpAuthorDraft, AUTHOR);
			const request = f.requests.find(request => request.supplementary)!;
			assert.equal(request.model, "writer");
			const input = JSON.parse((request.context.messages[0] as any).content[0].text);
			const expected = supplementaryInput(loadStageMaterials(f.cwd), author(f.sm).message.details.rpNarrative, AUTHOR);
			assert.deepEqual(Object.keys(input).sort(), ["authorDraft", "card", "entries", "narrative", "preset"]);
			assert.deepEqual(input, JSON.parse(expected.userText));
			assert.ok(input.entries.some((entry: any) => entry.content === FORMAT));
			assert.ok(!input.entries.some((entry: any) => entry.content === DISABLED));
			const delivery = receipts(f.sm).at(-1).data;
			assert.equal(delivery.text, SUPPLEMENT);
			assert.equal(delivery.authorHash, supplementaryHash(AUTHOR));
			assert.equal(delivery.narrativeHash, supplementaryHash(input.narrative));
			assert.equal(delivery.materialHash, expected.materialHash);
			ecology.resolve();
			await turn;
			assert.equal(ended, true);
			assert.equal(readyCount, 1);
			assert.equal(frozenAuthor(author(f.sm).message), snapshot);
			assert.equal(f.requests.filter(request => request.supplementary).length, 1);
			for (const request of f.requests.filter(request => !request.supplementary)) {
				assert.ok(!JSON.stringify(request.context).includes(SUPPLEMENT_ONLY_SENTINEL), `${request.model} must not consume supplementary facts`);
			}
			for (const entry of branch(f.sm).filter(entry => entry.customType !== SUPPLEMENTARY_ENTRY_TYPE)) {
				assert.ok(!JSON.stringify(entry).includes(SUPPLEMENT_ONLY_SENTINEL), "supplement must not mutate story, ledger or ecology entries");
			}
		} finally { ecology.resolve(); await turn; f.cleanup(); }
	});
}

for (const stale of ["cancel", "branch", "session", "card"] as const) {
	test(`supplementary rejects late output after source ${stale}`, { timeout: 15000 }, async () => {
		const started = deferred(), release = deferred();
		let ready = 0;
		const f = fixture("direct", { gate: async (_model, supplementary) => {
			if (supplementary) { started.resolve(); await release.promise; }
		}, events: { onSupplementaryReady: () => { ready++; } } });
		const turn = f.engine.performTurn("Continue the synthetic log.");
		try {
			await started.promise;
			const saved = author(f.sm), snapshot = frozenAuthor(saved.message);
			assert.equal(receipts(f.sm).at(-1).data.status, "pending");
			if (stale === "cancel") f.engine.abort();
			if (stale === "branch") f.sm.branch(branch(f.sm).find(entry => entry.message?.role === "user").id);
			if (stale === "session") f.sm.getSessionId = () => "changed-session";
			if (stale === "card") writeFileSync(join(f.cwd, "liyuan.config.json"), JSON.stringify({ card: "other.json" }));
			release.resolve();
			await turn;
			assert.equal(ready, 0);
			assert.ok(!f.sm.getEntries().some((entry: any) => entry.customType === SUPPLEMENTARY_ENTRY_TYPE && entry.data.status !== "pending"));
			assert.equal(frozenAuthor(saved.message), snapshot);
		} finally { release.resolve(); await turn; f.cleanup(); }
	});
}

test("supplementary normalization only discards whitespace and whole empty fences", () => {
	for (const text of ["", " \t\r\n", "```html\n```", " \n```unknown-format\r\n \t\r\n```\n ", "~~~\n\n~~~~", "````\n \n````"])
		assert.equal(normalizeSupplementaryText(text), "");
	for (const text of [" \n```html\n<p>Real content</p>\n```\n ", "```unknown-format\ntext\n```", "~~~js\nconst x = 1;\n~~~", " \n<unknown-format />\n ", " {\"unknown\": []} ", "```\n```\n```\n```", "```\n~~~", "````\n```", "```html", "before\n```\n```", "```\n```\nafter", "```text```"])
		assert.equal(normalizeSupplementaryText(text), text);
});

for (const mode of ["direct", "director"] as const) {
for (const supplement of ["", " \t\r\n", "```html\n```", " \n```unknown-format\r\n \t\r\n```\n ", "~~~\n \n~~~~", " \n```html\n<p>Real content</p>\n```\n ", "```unknown-format\ntext\n```", " \n<unknown-format />\n "]) {
test(`${mode}: supplementary terminal response ${JSON.stringify(supplement)} preserves author without extra calls`, { timeout: 15000 }, async () => {
	let ready = 0;
	let snapshot = "";
	const text = normalizeSupplementaryText(supplement);
	const f = fixture(mode, { supplement, events: {
		onAuthorReady: () => { snapshot = frozenAuthor(author(f.sm).message); },
		onSupplementaryReady: () => { ready++; },
	} });
	try {
		await f.engine.performTurn("Continue the synthetic log.", { generationMode: mode });
		assert.equal(receipts(f.sm).at(-1).data.status, text ? "complete" : "skipped");
		assert.equal(receipts(f.sm).at(-1).data.text, text);
		assert.equal(ready, 1);
		assert.equal(author(f.sm).message.details.rpAuthorDraft, AUTHOR);
		assert.equal(frozenAuthor(author(f.sm).message), snapshot);
		assert.equal(f.requests.filter(request => request.supplementary).length, 1);
		const count = f.requests.length;
		const receiptCount = receipts(f.sm).length;
		assert.equal((await f.engine.retryPendingSettlement()).error, undefined);
		assert.equal(f.requests.length, count);
		assert.equal(receipts(f.sm).length, receiptCount);
		assert.equal(ready, 1);
	} finally { f.cleanup(); }
});
}
}

for (const mode of ["direct", "director"] as const) {
	test(`${mode}: native retention does not activate unrelated enabled worldbook entries`, { timeout: 15000 }, async () => {
		const f = fixture(mode, { nativeSelection: [0, 1, 3, 4, 5] });
		try {
			await f.engine.performTurn("Continue the synthetic log.");
			const request = f.requests.find(request => request.supplementary)!;
			const input = JSON.parse((request.context.messages[0] as any).content[0].text);
			assert.deepEqual(input.entries.map((entry: any) => entry.content), [FORMAT, "ACTIVATED_MATERIAL: output <activated_note>…</activated_note> at the end", "Native protocol: output <UpdateVariable>…</UpdateVariable> after the reply"]);
			assert.equal(receipts(f.sm).at(-1).data.status, "complete");
			assert.equal(receipts(f.sm).at(-1).data.materialView.entryHashes.length, 3);
			assert.ok(!JSON.stringify(request.context).includes("UNACTIVATED_MATERIAL"));
		} finally { f.cleanup(); }
	});
	test(`${mode}: native supplementary validates the frozen selected view including activated entries`, { timeout: 15000 }, async () => {
		const f = fixture(mode, { nativeSelection: [0, 1, 3, 4] });
		try {
			await f.engine.performTurn("Continue the synthetic log.");
			assert.equal(receipts(f.sm).at(-1).data.status, "complete");
			const request = f.requests.find(request => request.supplementary)!;
			const input = JSON.parse((request.context.messages[0] as any).content[0].text);
			assert.deepEqual(input.entries.map((entry: any) => entry.content), [FORMAT, "ACTIVATED_MATERIAL: output <activated_note>…</activated_note> at the end", "Native protocol: output <UpdateVariable>…</UpdateVariable> after the reply"]);
			assert.equal(f.requests.filter(request => request.supplementary).length, 1);
		} finally { f.cleanup(); }
	});
}

for (const edit of ["selected", "unselected", "card", "preset"] as const) {
	test(`native supplementary ${edit === "unselected" ? "retains selection after" : "rejects"} ${edit} edits`, { timeout: 15000 }, async () => {
		const started = deferred(), release = deferred();
		const f = fixture("direct", { nativeSelection: [0, 3, 4], gate: async (_model, supplementary) => {
			if (supplementary) { started.resolve(); await release.promise; }
		} });
		const turn = f.engine.performTurn("Continue the synthetic log.");
		try {
			await started.promise;
			const path = join(f.cwd, "card.json"), card = JSON.parse(readFileSync(path, "utf8"));
			if (edit === "card") card.data.description = "Changed keeper: output <changed_card>…</changed_card> after the reply";
			else if (edit === "preset") {
				mkdirSync(join(f.cwd, "presets"));
				writeFileSync(join(f.cwd, "presets", "默认.json"), JSON.stringify({ prompts: [{ identifier: "changed", name: "Changed", content: "Changed preset: output <changed_preset>…</changed_preset> at the end", enabled: true }], prompt_order: [{ order: [{ identifier: "changed", enabled: true }] }] }));
			}
			else card.data.character_book.entries[edit === "selected" ? 3 : 2].content += " changed";
			if (edit !== "preset") writeFileSync(path, JSON.stringify(card));
			release.resolve(); await turn;
			assert.equal(receipts(f.sm).at(-1).data.status, edit === "unselected" ? "complete" : "failed");
			assert.equal(author(f.sm).message.details.rpAuthorDraft, AUTHOR);
		} finally { release.resolve(); await turn; f.cleanup(); }
	});
}

test("native supplementary recovery preserves selection without rerunning activation", { timeout: 15000 }, async () => {
	const started = deferred(), release = deferred();
	let first = true;
	const selection = [0, 3, 4];
	const f = fixture("direct", { nativeSelection: selection, gate: async (_model, supplementary) => {
		if (supplementary && first) { first = false; started.resolve(); await release.promise; }
	} });
	const turn = f.engine.performTurn("Continue the synthetic log.");
	try {
		await started.promise; f.engine.abort(); release.resolve(); await turn;
		assert.equal(receipts(f.sm).at(-1).data.status, "pending");
		const original = f.requests.find(request => request.supplementary)!;
		selection.splice(0, selection.length, 2);
		const result = await f.engine.retryPendingSettlement();
		assert.equal(result.error, undefined);
		assert.equal(receipts(f.sm).at(-1).data.status, "complete");
		assert.deepEqual((f.requests.filter(request => request.supplementary).at(-1)!.context.messages[0] as any).content, (original.context.messages[0] as any).content);
		const count = f.requests.filter(request => request.supplementary).length;
		await f.engine.retryPendingSettlement();
		assert.equal(f.requests.filter(request => request.supplementary).length, count);
	} finally { release.resolve(); await turn; f.cleanup(); }
});

test("native supplementary recovery rejects changed selected materials before a new request", { timeout: 15000 }, async () => {
	const started = deferred(), release = deferred();
	const f = fixture("direct", { nativeSelection: [0, 3, 4], gate: async (_model, supplementary) => {
		if (supplementary) { started.resolve(); await release.promise; }
	} });
	const turn = f.engine.performTurn("Continue the synthetic log.");
	try {
		await started.promise; f.engine.abort(); release.resolve(); await turn;
		const path = join(f.cwd, "card.json"), card = JSON.parse(readFileSync(path, "utf8"));
		card.data.character_book.entries[3].enabled = false;
		writeFileSync(path, JSON.stringify(card));
		const result = await f.engine.retryPendingSettlement();
		assert.match(result.error ?? "", /Supplementary selected materials changed/);
		assert.equal(f.requests.filter(request => request.supplementary).length, 1);
		assert.equal(receipts(f.sm).at(-1).data.status, "pending");
	} finally { release.resolve(); await turn; f.cleanup(); }
});

for(const mode of ['direct','director'] as const){
 test(`${mode}: a supplementary failure recovered by the automatic retry closes its degraded domain, so the next turn starts without recovery`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let failures=1;const activities:string[]=[];
  const f=fixture(mode,{turns:2,events:{onActivity:(d:string)=>activities.push(d)},gate:async(_model,supplementary)=>{if(supplementary&&failures>0){failures--;throw Error('Supplementary JSON schema: invalid source-bound ancillary item');}}});
  try{
   await f.engine.performTurn('Synthetic turn A.');
   const a=author(f.sm);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   const settlement=branch(f.sm).filter(e=>e.customType==='rp-turn-settlement'&&e.data.narrativeEntryId===a.id).at(-1).data;
   assert.deepEqual(settlement.degradedDomains,[]);assert.equal(settlement.status,'complete');
   activities.length=0;
   await f.engine.performTurn('Synthetic turn B.');
   assert.ok(!activities.some(d=>d.includes('恢复上一拍未结算正文')),'recovered turn must not be re-recovered before the next input');
  }finally{f.cleanup();}
 });
}

test('a pending settlement whose only open domain is an already-resolved supplementary is closed by recovery without re-requesting it',async t=>{
 t.mock.method(settlementRetry,'wait',async()=>{});
 const f=fixture('direct',{turns:2});
 try{
  await f.engine.performTurn('Synthetic turn A.');const a=author(f.sm);
  const latest=branch(f.sm).filter(e=>e.customType==='rp-turn-settlement'&&e.data.narrativeEntryId===a.id).at(-1).data;
  // Legacy receipt written before the fix: supplementary later resolved, flag left behind.
  f.sm.appendCustomEntry('rp-turn-settlement',{...latest,status:'pending',degradedDomains:['supplementary']});f.sm.flush();
  const count=f.requests.filter(r=>r.supplementary).length;
  await f.engine.performTurn('Synthetic turn B.');
  assert.equal(f.requests.filter(r=>r.supplementary).length,count+1,'only turn B requests its own supplementary');
  const closed=branch(f.sm).filter(e=>e.customType==='rp-turn-settlement'&&e.data.narrativeEntryId===a.id).at(-1).data;
  assert.equal(closed.status,'complete');assert.deepEqual(closed.degradedDomains,[]);
 }finally{f.cleanup();}
});

for(const mode of ['direct','director'] as const){
 test(`${mode}: MVU after-turn settlement starts only after the supplementary receipt is terminal`,async()=>{
  const release=deferred();let supplementaryDone=false,mvuSawTerminal:boolean|undefined;
  const f=fixture(mode,{nativeSelection:[0,4],gate:async(_m,supplementary)=>{if(supplementary){await release.promise;supplementaryDone=true;}},
   tavernAfter:async()=>{mvuSawTerminal=supplementaryDone&&['complete','skipped'].includes(receipts(f.sm).at(-1)?.data.status);}});
  try{
   const turn=f.engine.performTurn('Synthetic turn.');
   await new Promise(r=>setTimeout(r,50));
   assert.equal(mvuSawTerminal,undefined,'MVU must not parse while supplementary is still running');
   release.resolve();await turn;
   assert.equal(mvuSawTerminal,true);
  }finally{f.cleanup();}
 });
 test(`${mode}: failed supplementary never completes MVU early; recovered updates are consumed once`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});
  let fail=true,afterCalls=0;
  const f=fixture(mode,{nativeSelection:[0,4],gate:async(_m,supplementary)=>{if(supplementary&&fail)throw Error('HTTP 401 synthetic failure');},
   tavernAfter:async()=>{afterCalls++;assert.equal(receipts(f.sm).at(-1).data.status,'complete');}});
  try{
   await f.engine.performTurn('Synthetic turn.');
   assert.equal(afterCalls,0);
   assert.equal(branch(f.sm).filter(e=>e.customType==='rp-tavern-plugin-settlement').at(-1).data.status,'pending');
   fail=false;assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(afterCalls,1);
   await f.engine.retryPendingSettlement();assert.equal(afterCalls,1);
  }finally{f.cleanup();}
 });
 test(`${mode}: automatic supplementary recovery releases MVU exactly once`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let failures=1,afterCalls=0;
  const f=fixture(mode,{nativeSelection:[0,4],gate:async(_m,supplementary)=>{if(supplementary&&failures-->0)throw Error('ETIMEDOUT');},
   tavernAfter:async()=>{afterCalls++;assert.equal(receipts(f.sm).at(-1).data.status,'complete');}});
  try{await f.engine.performTurn('Synthetic turn.');assert.equal(afterCalls,1);assert.equal(branch(f.sm).filter(e=>e.customType==='rp-tavern-plugin-settlement').at(-1).data.status,'complete');}
  finally{f.cleanup();}
 });
 test(`${mode}: display-only supplementary failure does not block native settlement`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let afterCalls=0;
  const f=fixture(mode,{nativeSelection:[0],gate:async(_m,supplementary)=>{if(supplementary)throw Error('HTTP 401 synthetic failure');},tavernAfter:async()=>{afterCalls++;}});
  try{await f.engine.performTurn('Synthetic turn.');assert.equal(afterCalls,1);assert.equal(branch(f.sm).filter(e=>e.customType==='rp-tavern-plugin-settlement').at(-1).data.status,'complete');}
  finally{f.cleanup();}
 });
 test(`${mode}: the next input recovers missing variables before acknowledgement and does not replay completed MVU`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let fail=true,afterCalls=0;
  const patch='<UpdateVariable><JSONPatch>[{"op":"add","path":"/synthetic","value":1}]</JSONPatch></UpdateVariable>';
  const ended: Array<{error?:string}> = [], applied: string[] = [];
  const f=fixture(mode,{turns:2,nativeSelection:[0,4],events:{onTurnEnd:info=>ended.push(info)},
   rawSupplement:JSON.stringify({version:2,narrative:null,items:[{source:'entries.0',requirement:FORMAT,text:SUPPLEMENT},{source:'entries.1',requirement:'Native protocol: output <UpdateVariable>…</UpdateVariable> after the reply',text:patch}]}),
   gate:async(_m,supplementary)=>{if(supplementary&&fail)throw Error('HTTP 401 synthetic failure');},tavernAfter:async entryId=>{
    const source=branch(f.sm).find(e=>e.id===entryId);
    assert.deepEqual(supplementaryMvuInput(branch(f.sm),entryId,source.message.details.rpAuthorDraft,source.message.details.rpNarrative),{__liyuanSupplementaryVariables:patch});
    applied.push(entryId);afterCalls++;
   }});
  try{
   await f.engine.performTurn('Synthetic A.');assert.equal(afterCalls,0);
   fail=false;let afterCallsAtAck:number|undefined;
   await f.engine.performTurn('Synthetic B.',{generationMode:mode,onAccepted:()=>{afterCallsAtAck=afterCalls;}});
   assert.equal(ended.at(-1)?.error,undefined);assert.equal(afterCallsAtAck,1,'A variable settlement precedes B acknowledgement');assert.equal(afterCalls,2);
   assert.equal(new Set(applied).size,2,'each source consumes its own validated variable patch once');
    await f.engine.retryPendingSettlement();assert.equal(afterCalls,2,'completed MVU receipts are not replayed');
   }finally{f.cleanup();}
  });
 const displayOnly=JSON.stringify({version:2,narrative:null,items:[{source:'entries.0',requirement:FORMAT,text:SUPPLEMENT}]});
 const tavernStatus=(sm:SessionManager)=>branch(sm).filter(e=>e.customType==='rp-tavern-plugin-settlement').at(-1)?.data.status;
 const supplementaryRequests=(f:ReturnType<typeof fixture>)=>f.requests.filter(r=>r.supplementary);
 for(const [label,raw] of [['display-only items',displayOnly],['empty items',JSON.stringify({version:2,narrative:null,items:[]})]] as const)
 test(`${mode}: ${label} without the demanded variable update never complete or skip; one repair per attempt, then failed and MVU pending`,async t=>{
  t.mock.method(settlementRetry,'wait',async()=>{});let afterCalls=0;
  const f=fixture(mode,{nativeSelection:[0,4],rawSupplement:raw,tavernAfter:async()=>{afterCalls++;}});
  try{
   await f.engine.performTurn('Synthetic turn.');
   const all=receipts(f.sm).map(e=>e.data.status);
   assert.ok(!all.includes('complete')&&!all.includes('skipped'),'no false terminal success');
   assert.equal(all.at(-1),'failed');
   assert.match(receipts(f.sm).at(-1).data.error,/schema/);
   // Four bounded task attempts (unchanged), each with exactly one in-request correction.
   const calls=supplementaryRequests(f);
   assert.equal(calls.length,8);
   assert.equal(calls.filter(r=>r.context.systemPrompt!==calls[0].context.systemPrompt).length,4,'every other request is the repair');
   assert.ok(String(calls[0].context.systemPrompt).includes('<UpdateVariable>'),'protocol names the demanded variable artifact');
   assert.equal(afterCalls,0,'MVU never parses an absent variable update');
   assert.equal(tavernStatus(f.sm),'pending');
   const source=author(f.sm);
   assert.deepEqual(supplementaryMvuInput(branch(f.sm),source.id,source.message.details.rpAuthorDraft,source.message.details.rpNarrative),{});
  }finally{f.cleanup();}
 });
 test(`${mode}: a repaired response that adds the variable update completes with exactly one extra request and feeds MVU once`,async()=>{
  let afterCalls=0,mvu:unknown;
  const f=fixture(mode,{nativeSelection:[0,4],rawSupplementAt:index=>index===0?displayOnly:undefined,tavernAfter:async entryId=>{
   afterCalls++;const source=branch(f.sm).find(e=>e.id===entryId);
   mvu=supplementaryMvuInput(branch(f.sm),entryId,source.message.details.rpAuthorDraft,source.message.details.rpNarrative);
  }});
  try{
   await f.engine.performTurn('Synthetic turn.');
   assert.equal(supplementaryRequests(f).length,2);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.equal(afterCalls,1);assert.deepEqual(mvu,{__liyuanSupplementaryVariables:NOOP_PATCH});
   assert.equal(tavernStatus(f.sm),'complete');
  }finally{f.cleanup();}
 });
 test(`${mode}: a first response carrying the demanded no-op variable update completes without repair`,async()=>{
  let mvu:unknown;
  const f=fixture(mode,{nativeSelection:[0,4],tavernAfter:async entryId=>{const source=branch(f.sm).find(e=>e.id===entryId);
   mvu=supplementaryMvuInput(branch(f.sm),entryId,source.message.details.rpAuthorDraft,source.message.details.rpNarrative);}});
  try{
   await f.engine.performTurn('Synthetic turn.');
   assert.equal(supplementaryRequests(f).length,1);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.deepEqual(mvu,{__liyuanSupplementaryVariables:NOOP_PATCH});
  }finally{f.cleanup();}
 });
 test(`${mode}: when the author delivered the variable update, display-only supplementary output stays complete with the plain protocol`,async()=>{
  const draft=AUTHOR+'<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
  let afterCalls=0;
  const f=fixture(mode,{nativeSelection:[0,4],authorDraft:draft,variables:false,tavernAfter:async()=>{afterCalls++;}});
  try{
   await f.engine.performTurn('Synthetic turn.');
   const calls=supplementaryRequests(f);
   assert.equal(calls.length,1);assert.equal(calls[0].context.systemPrompt,SUPPLEMENTARY_PROTOCOL);
   assert.equal(receipts(f.sm).at(-1).data.status,'complete');
   assert.equal(afterCalls,1);
  }finally{f.cleanup();}
 });
}
