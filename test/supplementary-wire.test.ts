/** Synthetic saved drafts and receipts only; no production data or model calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { supplementaryDeliveryProjection, supplementaryMvuInput, toWireHistory } from "../server/wire.ts";
import { mvuParseSource, mvuParsingProjection } from "../web/public/tavern-compat/mvu-adapter.js";
import { parseGlobalActionOptions } from "../src/regex-options.ts";

const names = { charName: "Synthetic character", userName: "Synthetic user" };
const author = "<content>SYNTHETIC STORY</content>";
const narrative = "SYNTHETIC STORY";
const supplement = "<aside>SYNTHETIC SUPPLEMENT</aside>\n<options>1. Observe\n2. Ask</options>";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const receipt = (patch: Record<string, unknown> = {}) => ({
	type: "custom", customType: "rp-supplementary-delivery",
	data: { version: 1, sourceEntryId: "reply", authorHash: hash(author), narrativeHash: hash(narrative), status: "complete", text: supplement, ...patch },
});

test('version 2 publication validates structured response and frozen input, never falls back to legacy after invalid replacement',()=>{
 const frozenInput=JSON.stringify({card:{description:'Ancillary output requirement'},entries:[],preset:[],authorDraft:author,narrative});
 const response={version:2,narrative:null,items:[{source:'card.description',requirement:'Ancillary output requirement',text:supplement}]};
 const valid=receipt({version:2,frozenInput,materialHash:hash(frozenInput),response});
 assert.equal(supplementaryDeliveryProjection([valid],'reply',author,narrative).rpSupplementaryText,supplement);
 for(const patch of [{text:'tampered'},{frozenInput:frozenInput+' '},{response:{...response,narrative:'second story'}}]){
  const invalid={...valid,data:{...valid.data,...patch}};
  assert.equal(supplementaryDeliveryProjection([receipt(),invalid],'reply',author,narrative).rpSupplementaryText,undefined);
 }
 assert.equal(supplementaryDeliveryProjection([receipt(),receipt({version:2,status:'pending'})],'reply',author,narrative).rpSupplementaryText,undefined);
});

test("supplement projection verifies both exact hashes, source, version and receipt shape", () => {
	assert.deepEqual(supplementaryDeliveryProjection([receipt()], "reply", author, narrative), {
		rpSupplementaryDelivery: { status: "complete" }, rpSupplementaryText: supplement,
  rpSupplementaryReceipt:{status:'complete',version:1,receiptHash:hash(JSON.stringify(receipt().data))},
	});
	for (const patch of [{ sourceEntryId: "sibling" }, { authorHash: hash(author + " ") }, { narrativeHash: hash(narrative + " ") }, { version: 5 }, { status: "unknown" }]) {
		assert.deepEqual(supplementaryDeliveryProjection([receipt(patch)], "reply", author, narrative), {});
	}
	assert.deepEqual(supplementaryDeliveryProjection([], "reply", author, narrative), {});
	assert.deepEqual(supplementaryDeliveryProjection([receipt()], "reply", undefined, narrative), {});
});

test("latest matching receipt wins; noncomplete and malformed complete never expose text or errors", () => {
	for (const status of ["pending", "failed", "skipped"]) {
		assert.deepEqual(supplementaryDeliveryProjection([receipt(), receipt({ status, error: "PRIVATE ERROR" })], "reply", author, narrative), { rpSupplementaryDelivery: { status },rpSupplementaryReceipt:{status,version:1,receiptHash:hash(JSON.stringify(receipt({status,error:'PRIVATE ERROR'}).data))} });
	}
	for (const text of [undefined, 7, "  "]) {
		assert.deepEqual(supplementaryDeliveryProjection([receipt({ text })], "reply", author, narrative), { rpSupplementaryDelivery: { status: "complete" },rpSupplementaryReceipt:{status:'complete',version:1,receiptHash:hash(JSON.stringify(receipt({text}).data))} });
	}
	assert.equal(supplementaryDeliveryProjection([receipt(), receipt({ authorHash: "stale" })], "reply", author, narrative).rpSupplementaryText, supplement);
});

for (const mode of ["direct", "director"]) test(`${mode}: supplement follows selected author/Veridis display once, preserving author and facts`, () => {
	for (const rewrite of [false, true]) {
		const message = { role: "assistant", content: narrative, details: {
			rpEntryId: "reply", rpGenerationMode: mode, rpAuthorDraft: author, rpNarrative: narrative,
			rpTimeline: [{ kind: "thinking", text: "PRIVATE THINKING" }, { kind: "text", text: narrative }],
			...supplementaryDeliveryProjection([receipt()], "reply", author, narrative),
		} };
		const before = JSON.stringify(message);
		const options = rewrite ? { displayOverrides: new Map([["reply", "SYNTHETIC REWRITE"]]) } : undefined;
		const wire = toWireHistory([message], names, options)[0];
		assert.equal(wire.authorDelivery, author);
		assert.match(wire.text, rewrite ? /SYNTHETIC REWRITE/ : /SYNTHETIC STORY/);
		assert.equal(wire.text.split("SYNTHETIC SUPPLEMENT").length - 1, 1);
		assert.equal(wire.timeline?.filter(segment => segment.kind === "text").map(segment => segment.text).join(""), wire.text);
		const parsed = parseGlobalActionOptions(wire.text);
		assert.equal(parsed.status, "valid");
		if (parsed.status === "valid") assert.deepEqual(parsed.options, ["Observe", "Ask"]);
		assert.equal(toWireHistory([message], names, options)[0].text, wire.text);
		assert.equal(JSON.stringify(message), before);
	}
});

test("unfinished and backstage replies never receive supplementary display", () => {
	const message = { role: "assistant", content: narrative, details: { rpGenerationMode: "direct", rpAuthorDraft: author, ...supplementaryDeliveryProjection([receipt()], "reply", author, narrative) } };
	assert.doesNotMatch(toWireHistory([{ ...message, stopReason: "aborted" }], names)[0].text, /SUPPLEMENT/);
	assert.doesNotMatch(toWireHistory([{ role: "user", content: "// backstage" }, message], names)[1].text, /SUPPLEMENT/);
});

test("main projects receipts on cloned details and supplementary event resyncs without ending the turn", () => {
	const source = readFileSync(new URL("../server/main.ts", import.meta.url), "utf8");
	assert.match(source, /Object\.assign\(details, supplementaryDeliveryProjection\(branch, String\(entry.id\), details.rpAuthorDraft, details.rpNarrative\)\)/);
	const handler = source.slice(source.indexOf("onSupplementaryReady: () => {"), source.indexOf("onTurnEnd: (info) => {"));
	assert.match(handler, /resyncAll\(\)/);
	assert.match(handler, /if \(stage.isSettling\) broadcast/);
	assert.doesNotMatch(handler, /state: "end"/);
});

test('parent host busy and hello settling read independent engine regeneration state',()=>{
 const source=readFileSync(new URL('../server/main.ts',import.meta.url),'utf8');
 assert.match(source,/isStreaming: \(\) => session\.isStreaming \|\| stage\.isStreaming/);
 assert.match(source,/busy: \(\): boolean => session\.isStreaming \|\| \(typeof stage !== "undefined" && stage\.isStreaming\)/);
 assert.match(source,/readStorySettling = \(\) => stage\.isSettling/);
 const handler=source.slice(source.indexOf('regenerateSupplementary:async('),source.indexOf('retryNpcAdmission:async('));
 assert.match(handler,/stage\.regenerateSupplementary/);assert.match(handler,/resyncAll\(\);if\(stage\.isSettling\)broadcast\(\{type:'agent',state:'settling'\}\)/);
 assert.doesNotMatch(handler,/onAuthorReady/);
});

test('MVU receives only validated supplementary variable-update items, appended to the untouched author delivery',()=>{
 const patch='<UpdateVariable><JSONPatch>[{"op":"insert","path":"/list/-","value":"X"}]</UpdateVariable>';
 const frozenInput=JSON.stringify({card:{description:'Append PATCH to the update list. Also show options.'},entries:[],preset:[],authorDraft:author,narrative});
 const response={version:2,narrative:null,items:[{source:'card.description',requirement:'Append PATCH to the update list.',text:patch},{source:'card.description',requirement:'Also show options.',text:'<options>1. a</options>'}]};
 const valid=receipt({version:2,frozenInput,materialHash:hash(frozenInput),response,text:patch+'\n\n<options>1. a</options>'});
 const input=supplementaryMvuInput([valid],'reply',author,narrative);
 assert.equal(input.__liyuanSupplementaryVariables,patch,'display-only ancillary text never reaches MVU');
 const source=mvuParseSource(author,input.__liyuanSupplementaryVariables);
 assert.ok(source.startsWith(author)&&source.endsWith(patch));
 assert.match(mvuParsingProjection(source).text,/<\/JSONPatch>/,'the shared JSONPatch closing-tag repair still applies');
 assert.equal(mvuParseSource(author,undefined),author,'no supplement: MVU input is byte-identical to the author delivery');
 for(const bad of [receipt({version:2,status:'pending'}),{...valid,data:{...valid.data,text:'tampered'}},receipt({version:2,frozenInput,materialHash:hash(frozenInput),response,authorHash:hash('other draft')})])
  assert.deepEqual(supplementaryMvuInput([bad],'reply',author,narrative),{},'unverified or foreign receipts never feed MVU');
 assert.deepEqual(supplementaryMvuInput([valid],'other-reply',author,narrative),{});
});

test('v3 supplementary input freezes only materials that demand an output the author did not deliver',async()=>{
 const {supplementaryRequirementEntries,demandedTags,supplementaryHasRequirements}=await import('../src/stage/supplementary.ts');
 const entries=[
  {name:'lore',content:'学校设定：<校园地图>东区是宿舍</校园地图>'},
  {name:'options',content:'在每次正文结束后，严格按照以下格式输出行动选项。\n<options>\n1. …\n</options>'},
  {name:'calendar',content:'回复末尾输出 <calendar>本月日历</calendar>'},
  {name:'ejs',content:'<%_ var x = "<UpdateVariable>输出</UpdateVariable>" _%>普通设定'},
  {name:'event',content:'后处理:\n请在本次回复末尾的<UpdateVariable>中追加以下 JSONPatch\n</UpdateVariable>'},
 ];
 assert.deepEqual(demandedTags(entries[0].content),[],'setting text with tags but no output cue is not a requirement');
 assert.deepEqual(demandedTags(entries[3].content),[],'template code is executed by the host, not an output demand');
 const draft='<content>故事</content><calendar>已交</calendar>';
 assert.deepEqual(supplementaryRequirementEntries(entries,draft).map(e=>e.name),['options','event'],'delivered calendar is not resent');
 assert.deepEqual(supplementaryRequirementEntries(entries,draft+'<options>1.</options><UpdateVariable>[]</UpdateVariable>'),[]);
 assert.equal(supplementaryHasRequirements(JSON.stringify({card:{name:'c'},entries:[],preset:[]})),false);
});

test('MVU consumes exactly the validated receipt, never stale replacements or legacy response fields',()=>{
 const patch='<updatevariable><JSONPatch>[]</JSONPatch></updatevariable>';
 const frozenInput=JSON.stringify({card:{description:'Append PATCH'},entries:[],preset:[],authorDraft:author,narrative});
 const response={version:2,narrative:null,items:[{source:'card.description',requirement:'Append PATCH',text:patch}]};
 const valid=receipt({version:4,frozenInput,materialHash:hash(frozenInput),response,text:patch});
 const stale=receipt({version:3,authorHash:'other-author',response:{...response,items:[{...response.items[0],text:'<UpdateVariable>STALE</UpdateVariable>'}]}});
 assert.deepEqual(supplementaryMvuInput([valid,stale],'reply',author,narrative),{__liyuanSupplementaryVariables:patch});
 assert.deepEqual(supplementaryMvuInput([receipt({response,text:patch})],'reply',author,narrative),{});
 assert.deepEqual(supplementaryMvuInput([valid,receipt({version:3,status:'pending'})],'reply',author,narrative),{});
 const partial='<UpdateVariable>incomplete';
 const incomplete=receipt({version:3,frozenInput,materialHash:hash(frozenInput),response:{...response,items:[{...response.items[0],text:partial}]},text:partial});
 assert.deepEqual(supplementaryMvuInput([incomplete],'reply',author,narrative),{});
});

test('a paraphrased requirement still binds when the source demands the delivered artifact; unrelated artifacts stay rejected',async()=>{
 const {parseSupplementaryResponse}=await import('../src/stage/supplementary.ts');
 const ut=JSON.stringify({card:{name:'c'},entries:[{name:'theater',content:'回复末尾输出 <Small_theater>…</Small_theater>'},{name:'options',content:'严格按照格式输出 <options>…</options>'}],preset:[]});
 const parsed=parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[{source:'entries.0',requirement:'模型改写过的要求',text:'<Small_theater>x</Small_theater>'},{source:'entries.0',requirement:'标错来源',text:'<options>1.</options>'}]}),ut);
 assert.deepEqual((parsed.response as any).items.map((i:any)=>i.source),['entries.0','entries.1']);
 assert.throws(()=>parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[{source:'entries.1',requirement:'无关',text:'<foo>x</foo>'}]}),ut),/schema/);
 assert.throws(()=>parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items:[{source:'entries.9',requirement:'无',text:'<Small_theater>x</Small_theater>'}]}),JSON.stringify({card:{name:'c'},entries:[{name:'a',content:'输出 <Small_theater>…</Small_theater>'},{name:'b',content:'输出 <Small_theater>…</Small_theater>'}],preset:[]})),/schema/,'ambiguous owner is not guessed');
});

test('requirement matching uses closed case-insensitive pairs, not an opening tag or a template fragment',async()=>{
 const {supplementaryRequirementEntries,demandedTags,parseSupplementaryResponse}=await import('../src/stage/supplementary.ts');
 const entry={content:'Output <UpdateVariable class="patch">…</updatevariable >'};
 assert.deepEqual(demandedTags(entry.content),['UpdateVariable']);
 for(const draft of ['<UpdateVariable>partial','</UpdateVariable><UpdateVariable>','<UpdateVariable/>','<%="<UpdateVariable>[]</UpdateVariable>"%>'])
  assert.equal(supplementaryRequirementEntries([entry],draft).length,1,draft);
 assert.deepEqual(supplementaryRequirementEntries([entry],'<UPDATEVARIABLE class="patch">[]</updatevariable >'),[]);
 const input=JSON.stringify({card:{},entries:[entry],preset:[]});
 const response={version:2,narrative:null,items:[{source:'entries.0',requirement:'paraphrased output requirement',text:'<updatevariable>[]</UPDATEVARIABLE>'}]};
 assert.equal(parseSupplementaryResponse(JSON.stringify(response),input).text,response.items[0].text);
 assert.throws(()=>parseSupplementaryResponse(JSON.stringify({...response,items:[{...response.items[0],text:'<UpdateVariable>partial'}]}),input),/schema/);
});

test('MVU waits only for missing variable artifacts, not display-only supplementary failures',async()=>{
 const {supplementaryNeedsMvu}=await import('../src/stage/supplementary.ts');
 const input={card:{},entries:[{content:'Output <panel>status</panel>'}],preset:[],authorDraft:author};
 assert.equal(supplementaryNeedsMvu(JSON.stringify(input)),false);
 input.entries.push({content:'Output <UpdateVariable>patch</UpdateVariable>'});
 assert.equal(supplementaryNeedsMvu(JSON.stringify(input)),true);
 assert.equal(supplementaryNeedsMvu(JSON.stringify({...input,authorDraft:author+'<updatevariable>[]</UPDATEVARIABLE>'})),false);
});

test('generation-time MVU completeness requires a paired variable-update item only when the frozen input needs one',async()=>{
 const {supplementaryMvuMissing,supplementarySystemPrompt,SUPPLEMENTARY_PROTOCOL,parseSupplementaryResponse}=await import('../src/stage/supplementary.ts');
 const {settlementFailureRetryable}=await import('../src/stage/settlement-retry.ts');
 const needs=JSON.stringify({card:{name:'c'},entries:[{name:'panel',content:'Output <panel>status</panel>'},{name:'vars',content:'Output <updatevariable>patch</updatevariable> at the end'}],preset:[],authorDraft:author,narrative});
 const display={source:'entries.0',requirement:'Output',text:'<panel>s</panel>'};
 const parsed=(items:unknown[])=>parseSupplementaryResponse(JSON.stringify({version:2,narrative:null,items}),needs).response;
 // Display-only, empty, and an unclosed variable fragment riding on a valid display item.
 for(const items of [[display],[],[{...display,text:'<panel>s</panel> <updatevariable>unclosed'}]]){
  const error=supplementaryMvuMissing(needs,parsed(items));
  assert.match(error??'',/^Supplementary JSON schema: missing required variable-update artifact <updatevariable>/);
  assert.equal(settlementFailureRetryable(error!),true,'existing bounded retries apply');
 }
 assert.equal(supplementaryMvuMissing(needs,parsed([display,{source:'entries.1',requirement:'x',text:'<UpdateVariable>[]</UpdateVariable>'}])),undefined,'a no-op update is legal');
 // Display-only demands stay optional; an author-delivered update removes the dependency.
 const displayOnly=JSON.stringify({card:{name:'c'},entries:[{name:'panel',content:'Output <panel>status</panel>'}],preset:[],authorDraft:author,narrative});
 assert.equal(supplementaryMvuMissing(displayOnly,{version:2,narrative:null,items:[]}),undefined);
 const delivered=JSON.stringify({...JSON.parse(needs),authorDraft:author+'<UpdateVariable>[]</UpdateVariable>'});
 assert.equal(supplementaryMvuMissing(delivered,{version:2,narrative:null,items:[]}),undefined);
 // The protocol suffix is derived from the demanded tag and source key, not from card or entry names.
 assert.equal(supplementarySystemPrompt(displayOnly),SUPPLEMENTARY_PROTOCOL);
 assert.equal(supplementarySystemPrompt(delivered),SUPPLEMENTARY_PROTOCOL);
 const prompt=supplementarySystemPrompt(needs);
 assert.ok(prompt.startsWith(SUPPLEMENTARY_PROTOCOL)&&prompt.includes('<updatevariable>')&&prompt.includes('entries.1'));
 assert.ok(!prompt.includes('vars')&&!prompt.includes('panel'));
});

test('a historical complete receipt without a variable update still projects for display; MVU simply gets nothing',()=>{
 const frozenInput=JSON.stringify({card:{name:'c'},entries:[{name:'options',content:'Output <options>…</options>'},{name:'vars',content:'Output <UpdateVariable>patch</UpdateVariable>'}],preset:[],authorDraft:author,narrative});
 const text='<options>1. Observe\n2. Ask</options>';
 const response={version:2,narrative:null,items:[{source:'entries.0',requirement:'Output <options>…</options>',text}]};
 const old=receipt({version:4,frozenInput,materialHash:hash(frozenInput),response,text});
 const projection=supplementaryDeliveryProjection([old],'reply',author,narrative);
 assert.equal((projection.rpSupplementaryDelivery as any).status,'complete');
 assert.equal(projection.rpSupplementaryText,text);
 assert.deepEqual(supplementaryMvuInput([old],'reply',author,narrative),{});
});

test('v3 frozen selection remains reconstructable while v4 repairs unfinished and mixed-case artifacts',async()=>{
 const {supplementaryInput}=await import('../src/stage/supplementary.ts');
 const materials={card:{name:'Synthetic'},entries:[{enabled:true,comment:'format',content:'Output <UpdateVariable>patch</UpdateVariable>'}]} as any;
 const partial='<UpdateVariable>unfinished';
 const old=supplementaryInput(materials,narrative,partial,3),current=supplementaryInput(materials,narrative,partial);
 assert.deepEqual(JSON.parse(old.userText).entries,[]);
 assert.equal(JSON.parse(current.userText).entries.length,1);
 assert.notEqual(old.materialHash,current.materialHash);
 assert.equal(supplementaryInput(materials,narrative,partial,3).userText,old.userText);
 const mixed='<updatevariable>[]</UPDATEVARIABLE>';
 assert.equal(JSON.parse(supplementaryInput(materials,narrative,mixed,3).userText).entries.length,1);
 assert.deepEqual(JSON.parse(supplementaryInput(materials,narrative,mixed).userText).entries,[]);
});
