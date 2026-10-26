import type {VeridisRewriteProvider} from "../src/stage/veridis-rewrite.ts";
import type {NpcParallelProvider} from "../src/stage/npc-parallel.ts";
import { presentationFixtureReply } from "./support/agent-presentation-fixture.ts";
import assert from "node:assert/strict";
import test, { beforeEach, afterEach, mock } from "node:test";
import { settlementRetry } from "../src/stage/settlement-retry.ts";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@liyuan/agent-runtime";
import { StageEngine, type StageStreamFn, type StageEvents, type StageEngineDeps } from "../src/stage/engine.ts";
import { applyConfigPatch } from "../server/rest.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { DIRECTOR_ROLES } from "../src/stage/agent-director.ts";
import { toWireMsg } from "../server/wire.ts";
import { defaultCardWorldProfile, loadCardWorldProfile, manifestFromProfile, saveCardWorldProfile, worldProfileFingerprint } from "../src/stage/literary-world-profile.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { RequestJournal } from "../src/stage/request-journal.ts";
import { SUPPLEMENTARY_PROTOCOL } from "../src/stage/supplementary.ts";
import { createServer } from "node:http";
import { streamSimple } from "@liyuan/ai/compat";

const normalDirector = JSON.stringify({ scenePressure: "既有事务", characterInitiatives: [{ character: "云澜", motive: "一起核对账目", immediateIntent: "取出账本", limit: "依据已知事实" }], candidateBeats: ["既有场景继续"] });
// Failed-domain fixtures exercise the retry boundary without sleeping in real time.
beforeEach(() => { mock.method(settlementRetry, "wait", async () => {}); });
afterEach(() => { mock.restoreAll(); });
const emptyReport = JSON.stringify({ summary: "依据现有材料完成", facts: [], inferences: [], candidates: [], issues: [] });
const consult = (phase: keyof typeof DIRECTOR_ROLES) => ({ calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "本拍报告" })) } }] });
const directorScript = (body: string) => [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: body }, consult("review"), { calls: [{ name: "finalize" }] }];
type DatabasePluginWorldbookEntry = { uid?: number; comment?: string; content: string; enabled?: boolean; type?: string; keys?: string[]; position?: string; depth?: number; order?: number; prevent_recursion?: boolean };
type DatabasePluginBeforeResult = { literaryDirectorHandled?: boolean; literaryDirection?: string; userInput: string; worldbookEntries: DatabasePluginWorldbookEntry[] };
type DatabasePluginMemoryFixture = NonNullable<StageEngineDeps['databasePluginMemory']> & { events?: string[] };
const recalledOrderEntryContent = "<AM0001同序附记>保留上游顺序</AM0001同序附记>";
const recalledEntryContent = "<记忆回溯>\n<recall>AM0001|Xd</recall>\n</记忆回溯>";
const recalledLoreGroup = `${recalledOrderEntryContent}\n\n${recalledEntryContent}`;
const recalledUserInput = (input: string) => `<本轮用户输入>${input}</本轮用户输入>\n<recall>AM0001|Xd</recall>`;
function pluginBeforeResult(input: string): DatabasePluginBeforeResult {
	return { userInput: recalledUserInput(input), worldbookEntries: [
		{ uid: 100, comment: "AM0001同序附记", content: recalledOrderEntryContent, enabled: true, type: "system", keys: ["AM0001"], position: "at_depth_as_system", depth: 2, order: 10, prevent_recursion: true },
		{ uid: 101, comment: "AM0001纪要正文", content: recalledEntryContent, enabled: true, type: "system", keys: ["AM0001"], position: "at_depth_as_system", depth: 2, order: 17, prevent_recursion: true },
		{ uid: 102, comment: "禁用纪要索引", content: "<已发生的事件概览>\nAM0002|禁用索引不得投送</已发生的事件概览>", enabled: false, type: "system", keys: ["AM0002"], position: "at_depth_as_system", depth: 2, order: 18, prevent_recursion: true },
	] };
}
function promptMessageText(message: any): string {
	if (typeof message?.content === "string") return message.content;
	if (Array.isArray(message?.content)) return message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
	return "";
}
const isPrimaryWriterRequest = (request: any) => request.model === "writer" && request.context.systemPrompt !== SUPPLEMENTARY_PROTOCOL;

for (const mode of ["direct", "director"] as const) for (const supportsTools of [true, false]) {
	test(`${mode}/${supportsTools}: native card lore uses source depth/role once, not legacy constant or related-lore channels`, async () => {
		const body = "Synthetic one-pass original.";
		const responses = mode === "direct" ? [{ text: body }] : supportsTools ? directorScript(body) : [
			{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "Synthetic A" }, { role: "idea-b", task: "Synthetic B" }] }) },
			{ text: body }, { text: '{"decision":"keep"}' },
		];
		const f = fixture(mode, responses, {
			supportsTools,
			databasePluginMemory: { enabled: () => true, before: async userInput => ({ userInput, worldbookEntries: [] }), after: async () => {}, recentHistoryMessages: () => 12 },
		});
		try {
			writeFileSync(join(f.cwd, "card.json"), JSON.stringify({ data: { name: "Synthetic", description: "Synthetic card.", character_book: { entries: [
				{ id: 1, content: "SYNTHETIC_DEEP", constant: true, position: "before_char", extensions: { position: 4, depth: 999, role: 0 } },
				{ id: 2, content: "SYNTHETIC_TAIL", keys: ["native-trigger"], extensions: { position: 4, depth: 0, role: 1 } },
				{ id: 3, content: "SYNTHETIC_DISABLED", constant: true, enabled: false },
			] } } }));
			await f.engine.performTurn("native-trigger");
			const writer = f.requests.find(isPrimaryWriterRequest);
			assert.ok(writer);
			assert.doesNotMatch(writer.context.systemPrompt, /SYNTHETIC_DEEP|SYNTHETIC_TAIL|SYNTHETIC_DISABLED/);
			assert.equal(writer.context.messages[0].role, "system");
			assert.equal(promptMessageText(writer.context.messages[0]), "SYNTHETIC_DEEP");
			const initial = JSON.stringify(writer.context);
			assert.equal(initial.split("SYNTHETIC_DEEP").length - 1, 1);
			assert.equal(initial.split("SYNTHETIC_TAIL").length - 1, 1);
			const tailAt = writer.context.messages.findIndex((message: any) => promptMessageText(message) === "SYNTHETIC_TAIL");
			assert.equal(writer.context.messages[tailAt].role, "user");
			assert.ok(writer.context.messages.slice(0, tailAt).some((message: any) => promptMessageText(message).includes("native-trigger")));
			assert.doesNotMatch(initial, /SYNTHETIC_DISABLED/);
			const saved = f.sm.getBranch().find((entry: any) => entry.message?.details?.rpAuthorDraft === body) as any;
			assert.ok(saved, "the single author's original is saved without a format retry");
		} finally { f.cleanup(); }
	});
}

function assertDatabasePluginOrder(events: string[]) {
	const before = events.indexOf("before"), writer = events.indexOf("writer"), after = events.lastIndexOf("after");
	assert.ok(before >= 0 && writer > before && after > writer, `expected before -> writer -> after, got ${events.join(" -> ")}`);
}

for (const mode of ["direct", "director"] as const) {
	test(`${mode}: bundled default preset reaches author once with original roles`, async () => {
		const body = "Synthetic default delivery.";
		const f = fixture(mode, mode === "direct" ? [{ text: body }] : directorScript(body));
		try {
			cpSync(new URL("../presets/", import.meta.url), join(f.cwd, "presets"), { recursive: true });
			const materials = loadStageMaterials(f.cwd);
			assert.ok(materials.presetBefore.length > 0);
			await f.engine.performTurn("Synthetic default input");
			const writer = f.requests.find(isPrimaryWriterRequest);
			for (const piece of materials.presetBefore) {
				assert.equal(writer.context.messages.filter((m: any) => m.role === piece.role && promptMessageText(m) === piece.text).length, 1);
				assert.ok(!writer.context.systemPrompt.includes(piece.text));
			}
		} finally { f.cleanup(); }
	});
}

for (const mode of ["direct", "director"] as const) for (const native of [false, true]) {
	test(`${mode}/${native}: author receives original preset roles and marker order on the first request`, async () => {
		const body = "Synthetic original delivery.";
		const f = fixture(mode, mode === "direct" ? [{ text: body }] : directorScript(body), {
			...(native ? { databasePluginMemory: { enabled: () => true, before: async (userInput: string) => ({ userInput, worldbookEntries: [
				{ content: "PRESET_NATIVE_DEPTH", constant: true, position: "at_depth_as_system", depth: 0 },
			] }), after: async () => {}, recentHistoryMessages: () => 12 } } : {}),
		});
		try {
			const prompts = [
				{ identifier: "s", role: "system", content: "PRESET_SYSTEM" },
				{ identifier: "u", role: "user", content: "PRESET_USER" },
				{ identifier: "charDescription", marker: true },
				{ identifier: "a", role: "assistant", content: "PRESET_ASSISTANT" },
				{ identifier: "chatHistory", marker: true },
				{ identifier: "t", role: "system", content: "PRESET_TAIL" },
				{ identifier: "ta", role: "assistant", content: "PRESET_TAIL_ASSISTANT" },
				{ identifier: "d", role: "user", content: "PRESET_DEPTH", injection_position: 1, injection_depth: 0 },
			];
			writeFileSync(join(f.cwd, ".liyuan", "preset-override.json"), JSON.stringify({ prompts,
				prompt_order: [{ character_id: 100001, order: prompts.map(p => ({ identifier: p.identifier, enabled: true })) }] }));
			// Select the override through the normal configured-preset path.
			const configPath = join(f.cwd, "liyuan.config.json");
			writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), preset: "synthetic.json" }));
			await f.engine.performTurn("PRESET_INPUT");
			const writer = f.requests.find(isPrimaryWriterRequest);
			assert.ok(writer);
			assert.doesNotMatch(writer.context.systemPrompt, /PRESET_SYSTEM|PRESET_USER|PRESET_ASSISTANT|PRESET_TAIL|PRESET_DEPTH/);
			const delivered = writer.context.messages.filter((m: any) => /^PRESET_/.test(promptMessageText(m)));
			assert.deepEqual(delivered.map((m: any) => [m.role, promptMessageText(m)]), [
				["system", "PRESET_SYSTEM"], ["user", "PRESET_USER"], ["assistant", "PRESET_ASSISTANT"],
				["user", "PRESET_DEPTH"], ...(native ? [["system", "PRESET_NATIVE_DEPTH"]] : []),
				["system", "PRESET_TAIL"], ["assistant", "PRESET_TAIL_ASSISTANT"],
			]);
			const messages = writer.context.messages as any[];
			const inputAt = messages.findIndex(m => promptMessageText(m).endsWith("PRESET_INPUT"));
			assert.ok(inputAt > messages.findIndex(m => promptMessageText(m) === "PRESET_ASSISTANT"));
			assert.ok(inputAt < messages.findIndex(m => promptMessageText(m) === "PRESET_DEPTH"));
			assert.ok(messages.some(m => m.role === "system" && promptMessageText(m) === "谨慎的同门"));
			assert.ok(f.sm.getBranch().some((entry: any) => entry.message?.details?.rpAuthorDraft === body));
		} finally { f.cleanup(); }
	});
}
function assertDatabaseRecallRequest(requests: any[], input: string) {
	const expectedUserInput = recalledUserInput(input);
	const writerRequests = requests.filter(request => request.model === "writer");
	const expected = writerRequests.find(request => {
		const messages = request.context?.messages;
		if (!Array.isArray(messages)) return false;
		const lastUser = [...messages].reverse().find((message: any) => message.role === "user");
		return promptMessageText(lastUser).endsWith(expectedUserInput);
	});
	assert.ok(expected, `a writer request must end its final user message with the plugin's exact writeback userInput; tails=${JSON.stringify(writerRequests.map(request => Array.isArray(request.context?.messages) ? [...request.context.messages].reverse().find((message: any) => message.role === "user") : null).map(message => promptMessageText(message).slice(-160)))}`);
	const messages = expected.context.messages as any[];
	const systemLore = messages.filter(message => message.role === "system" && promptMessageText(message).includes(recalledEntryContent));
	assert.equal(systemLore.length, 1, "the enabled original lore entries must remain one independent system message with their wrappers intact");
	assert.equal(promptMessageText(systemLore[0]), recalledLoreGroup, "same-position worldbook entries must preserve original order and wrapper bytes");
	const loreIndex = messages.indexOf(systemLore[0]);
	const originalMessages = messages.filter(message => message !== systemLore[0]);
	assert.equal(loreIndex, Math.max(0, originalMessages.length - 2), `at_depth_as_system depth=2 must insert relative to the message tail; roles=${JSON.stringify(messages.map((message: any, index: number) => ({ index, role: message.role, text: promptMessageText(message).slice(-90) })))}`);
	const serializedMessages = JSON.stringify(messages);
	assert.match(serializedMessages, /AM0001\|Xd/);
	assert.doesNotMatch(serializedMessages, /AM0002|禁用纪要索引|合成插件记忆|宿主概括/);
	assert.equal(messages.some((message: any) => /^(?:【剧情记忆】|合成插件记忆|宿主概括)/.test(promptMessageText(message).trim())), false, "the host must not prepend its own narrative-memory summary message");
	return expected;
}
function fixture(mode: "direct" | "director", responses: any[], options: { veridisSdk?: StageStreamFn; plotOptions?: StageEngineDeps["plotOptions"]; worldProfile?: "valid" | "invalid"; ecology?: boolean; ecologyReply?:(payload:any)=>unknown; world?: boolean; worldWithoutManifest?: boolean; sideStreaming?: boolean; supportsTools?: boolean; databasePluginMemory?: DatabasePluginMemoryFixture; events?: StageEvents; tavernPlugins?:any; veridisRewrite?:VeridisRewriteProvider; npcParallel?: NpcParallelProvider; npcReply?:(payload:any)=>unknown; scribeReply?: () => string; scribeResponse?: () => any; authGate?: () => Promise<void>; sideGate?: (model: string, context: any) => Promise<void> } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-dual-engine-"));
	writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "谨慎的同门", first_mes: "你来了。" } }));
	mkdirSync(join(cwd, ".liyuan"));
	cpSync(new URL("../skills/", import.meta.url), join(cwd, "skills"), { recursive: true });
	const steps = ["worldProfile", "literaryDirector", "literaryContinuity", "directorSetting", "directorIdeas", "directorReviewFacts", "directorReviewStyle", "ecologyRuntime", "literaryWorldFacts", "literaryWorld", "literaryWorldAudit", "scribe", ...(options.npcParallel ? ["npcParallel"] : []), ...(options.veridisRewrite ? ["veridisRewrite"] : [])];
	const config = { card: "card.json", userName: "沈舟", generationMode: mode, literaryQuality: "guided", literaryEcologyEnabled: options.ecology === true, literaryWorldEnabled: options.world === true, stepModels: Object.fromEntries(steps.map(id => [id, { provider: "faux", id }])) };
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify(config));
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
 if (options.world && !options.worldWithoutManifest) {
  const m=loadStageMaterials(cwd),profile=defaultCardWorldProfile(cwd,"card.json",m.card.name,"",m.card);
  profile.modules=[{id:"regional-environment",name:"Environment",mode:"active",cadence:"every-beat",kind:"environment",confidence:1} as any];
  sm.appendCustomEntry("rp-world-manifest",manifestFromProfile(profile));sm.flush();
 }
	const requests: any[] = []; let ledgerFail = false; let worldProfileValid = options.worldProfile === "valid";
	const model = { id: "writer", provider: "faux", maxTokens: 10000, compat: {
		...(options.sideStreaming === undefined ? {} : { streaming: options.sideStreaming }),
		...(options.supportsTools === undefined ? {} : { supportsTools: options.supportsTools }),
	} };
	const streamFn: StageStreamFn = (m, context, streamOptions) => {
		requests.push({ model: m.id, compat: { ...((m.compat as { streaming?: boolean } | undefined) ?? {}) }, context: structuredClone(context), options: streamOptions });
		if (m.id === "veridisRewrite" && options.veridisSdk) return options.veridisSdk(m, context, streamOptions);
		const supplementary = context.systemPrompt === SUPPLEMENTARY_PROTOCOL;
		if (m.id === "writer" && !supplementary) options.databasePluginMemory?.events?.push("writer");
		let response: any;
		// Independent supplementary delivery must not consume the primary author's script.
		if (supplementary) response = { text: '{"version":2,"narrative":null,"items":[]}', stopReason: "stop" };
		else if (m.id === "writer") response = presentationFixtureReply(context) ?? responses.shift();
        else if (m.id === "veridisRewrite") response={text:"净化后的合成措辞"};
        else if (m.id === "npcParallel") {
            const raw=promptMessageText(context.messages.find((x:any)=>x.role==="user"));
            response={text:raw==="nativeGeneration"?"阿青在书店整理书架。":JSON.stringify(options.npcReply?.(JSON.parse(raw))??{})};
        }
		else if (m.id === "worldProfile") response = { text: worldProfileValid ? JSON.stringify({ digest: "合成世界适配", modules: [] }) : "{}" };
		else if (m.id === "literaryDirector") response = { text: normalDirector };
		else if (m.id === "scribe") response = options.scribeResponse ? options.scribeResponse() : options.scribeReply ? {text:options.scribeReply()} : ledgerFail ? { text: "bad ledger" } : { text: JSON.stringify({ patch: { location: "书房" } }) };
  else if (m.id === "literaryWorldFacts" && options.world) {
   const userMessage=context.messages.find((x:any)=>x.role==="user") as any;
   const payload=JSON.parse(userMessage.content.find((x:any)=>x.type==="text").text);
   response={text:JSON.stringify({evidence:[{id:"e1",source:"narrative",locator:"narrative",quote:payload.frozen_narrative}],facts:[{id:"f1",kind:"action",subject:"云澜",predicate:"继续整理已有账目",actuality:"established",visibility:"limited",agency:"other",evidenceIds:["e1"]}],elapsed:{kind:"bounded",unit:"minute",min:0,max:1,evidenceIds:["e1"]},triggerFactIds:[],uncertainties:[]})};
  }
		else if (m.id === "literaryWorld") {
			const payload = JSON.parse(promptMessageText(context.messages.find((x: any) => x.role === "user")));
			response = { text: JSON.stringify({ version: 2, baseRound: payload.current_world.round, baseStateHash: payload.base_state_hash, outcome: "changed", digest: "Synthetic offscreen weather", moduleChanges: [{ moduleId: "regional-environment", baseRevision: payload.current_world.modules["regional-environment"]?.revision ?? 0, factIds: [], provenance: { kind: "generated-offscreen", sourceEntryId: payload.source_entry_id, worldRefs: [], timeEvidenceIds: ["e1"] }, reason: "Local weather develops during the elapsed minute.", nextModule: { id: "regional-environment", kind: "environment", summary: "Local weather", records: [{ id: "fog", facet: "event", label: "Valley mist", summary: "Mist begins forming away from the scene.", visibility: "discoverable" }] } }], nextLinks: [] }) };
		}
		else if (m.id === "literaryWorldAudit") response = { text: JSON.stringify({ verdict: "approve", issues: [], summary: "Synthetic offscreen proposal approved." }) };
		else if (m.id === "ecologyRuntime" && options.ecology) {
			const userMessage = context.messages.find((x: any) => x.role === "user") as any;
			const payload = JSON.parse(userMessage?.content?.find((x: any) => x.type === "text")?.text ?? "{}");
			if (payload.phase === "aftermath") {
				const saved = sm.getBranch().find((e: any) => e.id === payload.latest_turn.narrative_entry_id) as any;
				assert.equal(saved?.message?.details?.rpNarrative, payload.latest_turn.narrative, "trusted narrative must already be saved on the active branch");
				const disk = readFileSync(sm.getSessionFile()!, "utf8");
				assert.ok(disk.includes(payload.latest_turn.narrative_entry_id), "trusted source must have been flushed before ecology requests");
				response = { text: JSON.stringify({ actors: [{id:"yunlan",name:"云澜",tier:"background",location:"书房",activity:"整理桌上的账目",nextAction:"核对下一页"}], occurrences: [{ id: "library", name: "整理图书", userRole: "committed", userCommitment: { source: "narrative", sourceEntryId: saved.id, occurrenceId: "library", quote: payload.latest_turn.narrative } }] }) };
				if(options.ecologyReply)response={text:JSON.stringify(options.ecologyReply(payload))};
			} else response = { text: emptyReport };
		} else response = { text: emptyReport };
		if (!response) throw new Error(`unexpected request: ${m.id}`);
		const message: any = { role: "assistant", content: response.calls ? response.calls.map((c: any, i: number) => ({ type: "toolCall", id: `call-${requests.length}-${i}`, name: c.name, arguments: c.args ?? {} })) : [{ type: "text", text: response.text ?? "" }], stopReason: response.stopReason ?? (response.aborted ? "aborted" : response.error ? "error" : response.calls ? "toolUse" : "stop"), usage: { input: 10, output: 10 }, ...(response.error ? { errorMessage: response.error } : {}) };
		return { async *[Symbol.asyncIterator]() { await options.sideGate?.(m.id, context); if (response.text) yield { type: "text_delta", delta: response.text }; yield response.error ? { type: "error", error: message } : { type: "done", message }; }, async result() { return message; } } as never;
	};
	const engine = new StageEngine({ plotOptions: options.plotOptions, cwd, getSessionManager: () => sm as never, getModel: () => model, findModel: (provider, id) => ({ ...model, provider, id }), getAuth: async () => { await options.authGate?.(); return {}; }, streamFn, events: options.events, ...(options.veridisRewrite?{veridisRewrite:options.veridisRewrite}:{}), ...(options.npcParallel?{npcParallel:options.npcParallel}:{}), ...(options.databasePluginMemory ? {databasePluginMemory:options.databasePluginMemory} : {}),...(options.tavernPlugins?{tavernPlugins:options.tavernPlugins}:{}) });
	return { cwd, sm, requests, engine, setWorldProfileValid: (v: boolean) => { worldProfileValid = v; }, setLedgerFail: (value: boolean) => { ledgerFail = value; }, cleanup: () => { engine.abort();rmSync(cwd, { recursive: true, force: true }); } };
}
const replies = (sm: any) => sm.getBranch().filter((e: any) => e.type === "message" && e.message.role === "assistant");

for(const mode of ['direct','director'] as const)for(const recover of [false,true])test(`${mode}: ordinary new offscreen actor/event commits without canonical quote, recovery=${recover}`,async()=>{
 const body='Synthetic author remains in the study.';
 const f=fixture(mode,mode==='direct'?[{text:body}]:directorScript(body),{ecology:true,ecologyReply:payload=>{
  assert.ok(!payload.latest_turn.narrative.includes('warehouse'));
  if (recover) {
   assert.equal(payload.latest_turn.narrative,body);
   assert.ok(!payload.recent_history.some((item:any)=>item.text.includes(body)),"recovery must not repeat latest_turn in history");
   assert.ok(payload.recent_history.some((item:any)=>item.text.includes("Synthetic prior ancestor.")),"legal earlier narrative remains available");
  }
  return{actors:[{id:'new-keeper',name:'Synthetic keeper',location:'warehouse',activity:'checks stock',relations:['works with the porter'],knowledgeLedger:[{id:'stock-knowledge',subjectRef:'occurrence:stock',summary:'stock checked',certainty:'confirmed',route:'witnessed',sourceRef:'occurrence:stock',evidence:'personally counted the crates'}]}],occurrences:[{id:'stock',name:'Offscreen stock check',origin:'generated-offscreen',time:'current morning',location:'warehouse',participants:['new-keeper'],cause:'routine inventory',development:'the keeper counts crates',userRole:'none'}]};
 }});
 try{
  if(recover){
   f.sm.appendCustomEntry('rp-ecology-state',{version:1,round:7,actors:[],occurrences:[]});
   f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic prior ancestor.'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'Synthetic prior ancestor.',rpAuthorDraft:'Synthetic prior ancestor.',rpGenerationMode:mode}}as never);
   f.sm.appendMessage({role:'user',content:[{type:'text',text:'Continue.'}],timestamp:Date.now()}as never);
   const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:body}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:body,rpAuthorDraft:body,rpGenerationMode:mode}}as never);
   f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'pending',ledgerDone:true,worldDone:true,ecologyDone:false,presentationDone:true,degradedDomains:['ecology']});f.sm.flush();
   assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
  }else await f.engine.performTurn('Continue.',{generationMode:mode});
  const snapshots=f.sm.getBranch().filter((e:any)=>e.customType==='rp-ecology-state')as any[];
  const state=snapshots.at(-1).data;assert.equal(state.round,recover?8:1);assert.equal(state.actors[0].id,'new-keeper');
  assert.equal(state.occurrences[0].origin,'generated-offscreen');assert.equal(state.occurrences[0].narrativeEvidence,undefined);
   assert.equal(state._diagnosticSourceEntryId,replies(f.sm).at(-1).id);assert.equal(replies(f.sm).at(-1).message.details.rpAuthorDraft,body);
  const count=f.requests.length;assert.equal((await f.engine.retryPendingSettlement()).error,undefined);assert.equal(f.requests.length,count);
  assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==='rp-ecology-state').length,snapshots.length);
 }finally{f.cleanup();}
});

for (const mode of ["direct", "director"] as const) for (const action of ["commit", "cancel", "branch"] as const) test(`${mode}: generated offscreen world proposal keeps audit, source guards and recovery: ${action}`, async () => {
	const body = "Synthetic author: she stays in the study.";
	let stop = action !== "commit";
	let f: ReturnType<typeof fixture>;
	f = fixture(mode, mode === "direct" ? [{ text: body }] : [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: body }, consult("review"), { calls: [{ name: "finalize" }] }], {
		world: true,
		sideGate: async model => {
			if (model === "literaryWorldAudit" && stop) {
				stop = false;
				if (action === "cancel") f.engine.abort();
				else f.sm.branch(null);
			}
		},
	});
	try {
		const materials = loadStageMaterials(f.cwd);
		const profile = defaultCardWorldProfile(f.cwd, "card.json", materials.card.name, "", materials.card);
		profile.modules = [{ id: "regional-environment", name: "Environment", mode: "active", cadence: "every-beat", kind: "environment", confidence: 1 } as any];
		f.sm.appendCustomEntry("rp-world-manifest", manifestFromProfile(profile)); f.sm.flush();
		await f.engine.performTurn("Continue.", { generationMode: mode });
		if (action === "branch") {
			assert.equal(f.sm.getBranch().some((e: any) => e.customType === "rp-world-state"), false);
			return;
		}
		const saved = replies(f.sm).at(-1) as any;
		assert.equal(saved.message.details.rpNarrative, body);
		if (action === "cancel") {
			assert.equal(f.sm.getBranch().some((e: any) => e.customType === "rp-world-state"), false);
			const recovered = await f.engine.retryPendingSettlement();
			assert.equal(recovered.error, undefined);
		}
		const states = f.sm.getBranch().filter((e: any) => e.customType === "rp-world-state") as any[];
		assert.equal(states.length, 1, JSON.stringify({ requests: f.requests.map(r => r.model), receipts: f.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement" || e.customType === "rp-world-audit").map((e: any) => e.data) }));
		assert.equal(states[0].data.round, 1);
		assert.equal(states[0].data.modules["regional-environment"].provenance.sourceEntryId, saved.id);
		assert.equal(states[0].data.modules["regional-environment"].provenance.kind, "generated-offscreen");
		assert.equal(replies(f.sm).length, 1, "world recovery never rewrites the author");
		const calls = f.requests.length;
		await f.engine.retryPendingSettlement();
		assert.equal(f.requests.length, calls, "completed world is not advanced again");
	} finally { f.cleanup(); }
});

for (const invalid of ["authorComplete", "aborted", "length", "recovery"] as const) test(`settlement gate rejects modern incomplete ${invalid} before every background owner`, async () => {
	let background = 0;
	const f = fixture("direct", [], {ecology:true, world:true, databasePluginMemory:{enabled:()=>true,before:async userInput=>({userInput,worldbookEntries:[]}),after:async()=>{background++;},recentHistoryMessages:()=>12}});
	try {
		const id = f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"Synthetic partial."}],stopReason:invalid==="aborted"?"aborted":invalid==="length"?"length":"stop",details:{rpNarrative:"Synthetic partial.",rpAuthorDraft:"Synthetic partial.",rpGenerationMode:"direct",...(invalid==="recovery"?{rpGenerationWorkflow:{recovery:{status:"failed"}}}:{})}} as never);
		f.sm.appendCustomEntry("rp-turn-settlement",{narrativeEntryId:id,status:"pending",...(invalid==="authorComplete"?{authorComplete:false}:{}),ledgerDone:false,worldDone:false,ecologyDone:false});
		f.sm.appendCustomEntry("rp-database-memory",{sourceEntryId:id,status:"pending"});f.sm.flush();
		assert.match((await f.engine.retryPendingSettlement()).error??"",/半稿/);
		let accepted=0;await f.engine.performTurn("Must not accept.",{onAccepted:()=>accepted++});
		assert.equal(accepted,0);assert.equal(background,0);assert.equal(f.requests.length,0);
		assert.equal((f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data.status,"pending");
	} finally {f.cleanup();}
});

for (const allow of [true,false]) test(`scheduler retries degraded world regardless acceptance policy ${allow}`, async () => {
	let facts=0;
	const ends:any[]=[];
	const f=fixture("direct",[{text:"Synthetic complete."}],{world:true,sideGate:async model=>{if(model==="literaryWorld"&&++facts===1)throw Error("HTTP 503");},events:{onTurnEnd:info=>ends.push(info)}});
	try {
		const config=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));config.allowDegradedGeneration=allow;writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(config));
		await f.engine.performTurn("Continue.");assert.equal(facts,2);assert.equal(ends[0].error,undefined);
		assert.equal((f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data.worldDone,true);
	} finally {f.cleanup();}
});

for (const mode of ["direct", "director"] as const) for (const noDue of [false, true]) {
 test(`${mode}: world fact failure stays pending, recovery completes once (no due=${noDue})`, async () => {
  const body = "Synthetic complete source remains unchanged.";
  let failing = true, facts = 0;
  const f = fixture(mode, mode === "direct" ? [{text:body}] : directorScript(body), {world:true, ecology:true,
   sideGate: async model => { if (model === "literaryWorldFacts") { facts++; if (failing) throw Error("HTTP 524 Proxy Read Timeout"); } },
  });
  const receipts = () => f.sm.getBranch().filter((e:any) => e.customType === "rp-turn-settlement") as any[];
  const audits = () => f.sm.getBranch().filter((e:any) => e.customType === "rp-world-audit") as any[];
  try {
   if (noDue) {
    const m = loadStageMaterials(f.cwd), profile = defaultCardWorldProfile(f.cwd,"card.json",m.card.name,"",m.card);
    profile.modules = [];
    f.sm.appendCustomEntry("rp-world-manifest",manifestFromProfile(profile)); f.sm.flush();
   }
   await f.engine.performTurn("Continue.");
   assert.equal(facts, 4, "one initial attempt plus the existing three domain retries; no inner transport retry");
   assert.equal(receipts().at(-1).data.status,"pending");
   assert.equal(receipts().at(-1).data.worldDone,false);
   assert.equal(receipts().at(-1).data.ledgerDone,true);
   assert.equal(receipts().at(-1).data.ecologyDone,true);
   assert.equal(receipts().at(-1).data.presentationDone,true);
   assert.equal(audits().length,4);
   assert.ok(audits().every(e => e.data.status === "fact-failed"));
   assert.equal(f.requests.filter(r => r.model === "literaryWorld").length,0);
   assert.equal(f.sm.getBranch().filter((e:any) => e.customType === "rp-world-state").length,0);
   const saved = replies(f.sm).at(-1), completedCalls = f.requests.filter(r => ["scribe","ecologyRuntime"].includes(r.model)).length;
   failing = false;
   assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(facts,5);
   assert.equal(receipts().at(-1).data.status,"complete");
   assert.equal(receipts().at(-1).data.worldDone,true);
   assert.equal(audits().at(-1).data.status,"committed");
   assert.equal(f.sm.getBranch().filter((e:any) => e.customType === "rp-world-state").length,noDue ? 0 : 1);
   assert.equal(f.requests.filter(r => ["scribe","ecologyRuntime"].includes(r.model)).length,completedCalls);
   assert.equal(saved.message.details.rpNarrative,body);
   assert.equal(saved.message.details.rpAuthorDraft,body);
   const count = f.requests.length;
   await f.engine.retryPendingSettlement();
   assert.equal(f.requests.length,count,"completed domains do not rerun");
  } finally { f.cleanup(); }
 });
}

for (const mode of ["direct", "director"] as const) test(`${mode}: transient world fact failure recovers automatically without replaying independent domains`, async () => {
 let facts = 0;
 const body = "Synthetic automatic recovery source.";
 const f = fixture(mode,mode === "direct" ? [{text:body}] : directorScript(body),{world:true,ecology:true,
  sideGate:async model => {if(model === "literaryWorldFacts" && ++facts === 1) throw Error("HTTP 524 Proxy Read Timeout");}});
 try {
  await f.engine.performTurn("Continue.");
  assert.equal(facts,2);
  const receipt = (f.sm.getBranch().filter((e:any) => e.customType === "rp-turn-settlement").at(-1) as any).data;
  assert.equal(receipt.status,"complete"); assert.equal(receipt.worldDone,true);
  assert.equal(f.requests.filter(r => r.model === "scribe").length,1);
  assert.equal(f.requests.filter(r => r.model === "ecologyRuntime" && JSON.parse(promptMessageText(r.context.messages.find((m:any)=>m.role==='user'))).phase === "aftermath").length,1);
  assert.deepEqual((f.sm.getBranch().filter((e:any)=>e.customType === "rp-world-audit") as any[]).map(e=>e.data.status),["fact-failed","committed"]);
  assert.equal(replies(f.sm).at(-1).message.details.rpNarrative,body);
  const count=f.requests.length; await f.engine.retryPendingSettlement(); assert.equal(f.requests.length,count);
 } finally {f.cleanup();}
});

test("world fact authentication failure stays pending without automatic retry", async () => {
 const f=fixture("direct",[{text:"Synthetic complete."}],{world:true,sideGate:async model=>{if(model==="literaryWorldFacts")throw Error("HTTP 401 unauthorized");}});
 try {
  await f.engine.performTurn("Continue.");
  assert.equal(f.requests.filter(r=>r.model==="literaryWorldFacts").length,1);
  assert.equal(f.requests.filter(r=>r.model==="literaryWorld").length,0);
  const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;
  assert.equal(receipt.status,"pending");assert.equal(receipt.worldDone,false);
 } finally {f.cleanup();}
});

test("scheduler isolates permanent ledger from transient world/ecology/memory/plugins/projection", async () => {
	let memory=0,tavern=0,rewrite=0,facts=0,ecology=0,claims=0;
	const ends:any[]=[];
	const f=fixture("direct",[{text:"Synthetic complete."}],{world:true,ecology:true,scribeResponse:()=>({error:"HTTP 401 unauthorized"}),events:{onTurnEnd:info=>ends.push(info)},
		sideGate:async model=>{if(model==="literaryWorld"&&++facts===1)throw Error("HTTP 503");if(model==="ecologyRuntime"&&++ecology===1)throw Error("network reset");},
		databasePluginMemory:{enabled:()=>true,before:async userInput=>({userInput,worldbookEntries:[]}),after:async()=>{if(++memory===1)throw Error("HTTP 503");},recentHistoryMessages:()=>12},
		tavernPlugins:{enabled:()=>true,before:async(packet:any)=>({...packet,retainedWorldbookIndices:[]}),after:async()=>{if(++tavern===1)throw Error("network reset");}},
		veridisRewrite:{enabled:()=>true,claimRequest:(_scope,guard)=>{guard();claims++;},run:async input=>{await input.generate({messages:[{role:"user",content:"Synthetic"}],maxTokens:512});if(++rewrite===1)throw Error("HTTP 503");return{text:input.authorDraft,changed:false,calls:1,errors:[],version:"3.5",commit:"a".repeat(40)};}}});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(f.requests.filter(r=>r.model==="scribe").length,1);assert.equal(facts,2);assert.equal(ecology,2);assert.equal(memory,2);assert.equal(tavern,2);assert.equal(rewrite,2);assert.equal(claims,2);
		assert.match(ends[0].error??"",/401/);
		const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;
		assert.equal(receipt.ledgerDone,false);assert.equal(receipt.worldDone,true);assert.equal(receipt.ecologyDone,true);assert.ok(receipt.degradedDomains.includes("ledger"));
	} finally {f.cleanup();}
});

for(const domain of ["memory","tavern-plugins","rewrite"]) test(`missing ${domain} child receipt remains explicitly unresolved`,async()=>{
	const f=fixture("direct",[]);
	try{
		const id=f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"Synthetic complete."}],stopReason:"stop",details:{rpNarrative:"Synthetic complete.",rpAuthorDraft:"Synthetic complete.",rpGenerationMode:"direct"}} as never);
		f.sm.appendCustomEntry("rp-turn-settlement",{narrativeEntryId:id,status:"degraded",ledgerDone:true,worldDone:true,ecologyDone:true,presentationDone:true,degradedDomains:[domain]});f.sm.flush();
		assert.match((await f.engine.retryPendingSettlement()).error??"",/缺失来源收据/);
		const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;
		assert.ok(receipt.degradedDomains.includes(domain));assert.notEqual(receipt.status,"complete");assert.equal(f.requests.length,0);
	}finally{f.cleanup();}
});

test("scheduler reports exhausted transient degraded world instead of accepting success",async()=>{
	let facts=0;const ends:any[]=[];
	const f=fixture("direct",[{text:"Synthetic complete."}],{world:true,sideGate:async model=>{if(model==="literaryWorld"){facts++;throw Error("HTTP 503");}},events:{onTurnEnd:info=>ends.push(info)}});
	try{
		const config=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));config.allowDegradedGeneration=true;writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(config));
		await f.engine.performTurn("Continue.");assert.equal(facts,4);assert.match(ends[0].error??"",/503/);assert.equal((settlementRetry.wait as any).mock.callCount(),3);
		const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;assert.equal(receipt.worldDone,false);assert.notEqual(receipt.status,"complete");
	}finally{f.cleanup();}
});

test("scheduler permanent world does not stop transient ecology or repeat world request",async()=>{
	let facts=0,ecology=0;
	const f=fixture("direct",[{text:"Synthetic complete."}],{world:true,ecology:true,sideGate:async model=>{if(model==="literaryWorld"){facts++;throw Error("schema HTTP 401 unauthorized");}if(model==="ecologyRuntime"&&++ecology===1)throw Error("HTTP 503");}});
	try{await f.engine.performTurn("Continue.");assert.equal(facts,1);assert.equal(ecology,2);const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;assert.equal(receipt.worldDone,false);assert.equal(receipt.ecologyDone,true);}finally{f.cleanup();}
});

test("actual legacy source without modern completion flags retains settlement compatibility",async()=>{
	const f=fixture("direct",[]);
	try{
		const id=f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"Synthetic legacy."}],details:{rpNarrative:"Synthetic legacy."}} as never);
		f.sm.appendCustomEntry("rp-turn-settlement",{narrativeEntryId:id,status:"pending",ledgerDone:false,worldDone:true,ecologyDone:true,presentationDone:true});f.sm.flush();
		assert.equal((await f.engine.retryPendingSettlement()).error,undefined);assert.equal(f.requests.filter(r=>r.model==="scribe").length,1);
	}finally{f.cleanup();}
});

for(const domain of ["world","ecology"]) test(`disabled ${domain} without completion evidence cannot erase failure`,async()=>{
	const f=fixture("direct",[]);
	try{
		const id=f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"Synthetic complete."}],stopReason:"stop",details:{rpNarrative:"Synthetic complete.",rpAuthorDraft:"Synthetic complete.",rpGenerationMode:"direct"}} as never);
		f.sm.appendCustomEntry("rp-turn-settlement",{narrativeEntryId:id,status:"pending",ledgerDone:true,worldDone:domain!=="world",ecologyDone:domain!=="ecology",presentationDone:true,degradedDomains:[domain]});f.sm.flush();
		assert.match((await f.engine.retryPendingSettlement()).error??"",/未启用/);
		const receipt=(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data;
		assert.equal(receipt[`${domain}Done`],false);assert.ok(receipt.degradedDomains.includes(domain));assert.notEqual(receipt.status,"complete");assert.equal(f.requests.length,0);
	}finally{f.cleanup();}
});

for (const mode of ["direct", "director"] as const) test(`auto settlement ${mode}: transient ledger recovery keeps completed domains and author once`, async () => {
	let calls = 0, ready = 0, ended = 0, memory = 0;
	const f = fixture(mode, mode === "direct" ? [{text: "Synthetic finished story."}] : directorScript("Synthetic finished story."), {
		scribeResponse: () => ++calls === 1 ? {error: "network connection reset"} : {text: '{"patch":{"location":"Recovered room"}}'},
		events: {onAuthorReady: () => ready++, onTurnEnd: () => ended++}, world: true, ecology: true,
		databasePluginMemory: {enabled: () => true, before: async userInput => ({userInput, worldbookEntries: []}), after: async () => {memory++;}, recentHistoryMessages: () => 12},
	});
	try {
		await f.engine.performTurn("Continue synthetic story.");
		assert.equal(calls, 2); assert.equal(ready, 1); assert.equal(ended, 1); assert.equal(memory, 1);
		assert.equal(replies(f.sm).length, 1);
		assert.equal(f.requests.filter(r => r.model === "literaryWorldFacts").length, 1);
		assert.equal(f.requests.filter(r => r.model === "ecologyRuntime").length, mode === "director" ? 2 : 1);
		assert.equal((settlementRetry.wait as any).mock.callCount(), 1);
		assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement").at(-1) as any).data.status, "complete");
	} finally { f.cleanup(); }
});

for (const error of ["network connection reset", "HTTP 401 unauthorized", "[ProxySystem Error] SAFETY"]) test(`auto settlement bounded: ${error}`, async () => {
	let calls = 0;
	const ends: any[] = [];
	const f = fixture("direct", [{text: "Synthetic finished story."}], {scribeResponse: () => {calls++; return {error};}, events: {onTurnEnd: info => ends.push(info)}});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(calls, error.startsWith("network") ? 4 : 1, JSON.stringify(ends));
		assert.equal((settlementRetry.wait as any).mock.callCount(), error.startsWith("network") ? 3 : 0);
		assert.equal(replies(f.sm).length, 1); assert.ok(ends[0].error);
	} finally { f.cleanup(); }
});

for (const stale of ["cancel", "branch", "card", "session"] as const) test(`auto settlement discards ${stale} while waiting`, async () => {
	let waiting!: () => void, release!: () => void;
	const entered = new Promise<void>(r => waiting = r), gate = new Promise<void>(r => release = r);
	(settlementRetry.wait as any).mock.mockImplementation(async () => {waiting(); await gate;});
	let ready = 0;
	const f = fixture("direct", [{text: "Synthetic finished story."}], {scribeResponse: () => ({error: "network reset"}), events: {onAuthorReady: () => ready++}});
	try {
		const turn = f.engine.performTurn("Continue."); await entered;
		assert.equal(f.engine.isSettling, true); assert.equal(ready, 1);
		if (stale === "cancel") f.engine.abort();
		if (stale === "branch") f.sm.branch((f.sm.getBranch().find((e: any) => e.message?.role === "user") as any).id);
		if (stale === "card") writeFileSync(join(f.cwd, "liyuan.config.json"), JSON.stringify({card: "other.json"}));
		if (stale === "session") f.sm.getSessionId = () => "changed-session";
		release(); await turn;
		assert.equal(f.requests.filter(r => r.model === "scribe").length, 1);
		assert.equal(f.engine.isStreaming, false);
	} finally { release(); f.cleanup(); }
});

test("auto settlement holds queued input/ACK until recovery completes", async () => {
	let waiting!: () => void, release!: () => void, calls = 0, accepted = 0;
	const entered = new Promise<void>(r => waiting = r), gate = new Promise<void>(r => release = r);
	(settlementRetry.wait as any).mock.mockImplementation(async () => {waiting(); await gate;});
	const f = fixture("direct", [{text: "First synthetic story."}, {text: "Second synthetic story."}], {scribeResponse: () => ++calls === 1 ? {error: "network reset"} : {text: '{"patch":{}}'}});
	try {
		const first = f.engine.performTurn("First."); await entered;
		const second = f.engine.performTurn("Second.", {onAccepted: () => accepted++});
		assert.equal(accepted, 0); assert.equal(replies(f.sm).length, 1);
		assert.equal(f.sm.getBranch().filter((e: any) => e.message?.role === "user").length, 1);
		release(); await first; await second;
		assert.equal(accepted, 1); assert.equal(replies(f.sm).length, 2); assert.equal(calls, 3);
	} finally { release(); f.cleanup(); }
});

test("auto settlement retries database/Tavern/Veridis without replaying complete ledger", async () => {
	let memory = 0, tavern = 0, rewrite = 0, claims = 0;
	const activity: string[] = [];
	const f = fixture("direct", [{text: "Synthetic finished story."}], {
		events: { onActivity: text => activity.push(text) },
		databasePluginMemory: {enabled: () => true, before: async userInput => ({userInput, worldbookEntries: []}), after: async () => {if (++memory === 1) throw Error("network reset");}, recentHistoryMessages: () => 12},
		tavernPlugins: {enabled: () => true, before: async (packet: any) => ({...packet, retainedWorldbookIndices: []}), after: async () => {if (++tavern === 1) throw Error("HTTP 503");}},
		veridisRewrite: {enabled: () => true, claimRequest: (_scope, guard) => {guard(); claims++;}, run: async input => {
			await input.generate({messages: [{role: "user", content: "Synthetic rewrite"}], maxTokens: 512});
			if (++rewrite === 1) throw Error("network reset");
			return {text: input.authorDraft, changed: false, calls: 1, errors: [], version: "3.5", commit: "a".repeat(40)};
		}},
	});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(memory, 2, `memory=${memory}, tavern=${tavern}, rewrite=${rewrite}, requests=${f.requests.map(r => r.model)}`); assert.equal(tavern, 2); assert.equal(rewrite, 2); assert.equal(claims, 2);
		assert.equal(f.requests.filter(r => r.model === "scribe").length, 1); assert.equal(replies(f.sm).length, 1);
		assert.equal((settlementRetry.wait as any).mock.callCount(), 3);
		assert.deepEqual(activity.filter(text => text.startsWith("后台结算 ") && text.includes("独立重试")),
			["memory", "Tavern/MVU", "Veridis"].map(domain => `后台结算 ${domain} 将在5秒后独立重试 1/3`));
		assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement").at(-1) as any).data.status, "complete");
	} finally { f.cleanup(); }
});

test("auto settlement retries malformed ledger with the same managed role", async () => {
	let calls = 0;
	const f = fixture("direct", [{text: "Synthetic finished story."}], {scribeResponse: () => ++calls === 1 ? {text: "malformed ledger"} : {text: '{"patch":{}}'}});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(calls, 2); assert.equal((settlementRetry.wait as any).mock.callCount(), 1);
		assert.equal(f.requests.filter(isPrimaryWriterRequest).length, 1);
	} finally { f.cleanup(); }
});

test("auto settlement budget expiry during wait never starts recovery", async t => {
	let calls = 0;
	const ends: any[] = [];
	t.mock.timers.enable({apis: ["setTimeout"]});
	(settlementRetry.wait as any).mock.mockImplementation(async (signal: AbortSignal) => {
		assert.equal(signal.aborted, false);
		t.mock.timers.tick(30 * 60_000);
	});
	const f = fixture("direct", [{text: "Synthetic finished story."}], {scribeResponse: () => {calls++; return {error: "network timeout"};}, events: {onTurnEnd: info => ends.push(info)}});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(calls, 1); assert.equal(ends[0].aborted, true); assert.equal(replies(f.sm)[0].message.stopReason, "stop");
	} finally { f.cleanup(); }
});

test("manual settlement transient retries are bounded at initial plus three waits", async () => {
	let memory = 0, reason = "unknown deterministic failure";
	const f = fixture("direct", [{text: "Synthetic finished story."}], {databasePluginMemory: {enabled: () => true, before: async userInput => ({userInput, worldbookEntries: []}), after: async () => {memory++; throw Error(reason);}, recentHistoryMessages: () => 12}});
	try {
		await f.engine.performTurn("Continue.");
		assert.equal(memory, 1);
		reason = "HTTP 503";
		assert.match((await f.engine.retryPendingSettlement()).error ?? "", /503/);
		assert.equal(memory, 5); assert.equal((settlementRetry.wait as any).mock.callCount(), 3); assert.equal(replies(f.sm).length, 1);
	} finally { f.cleanup(); }
});

test("Veridis unset reaches the compiled SDK endpoint without a cap in settlement and manual retry", async () => {
  const payloads: any[] = [];
  const server = createServer((req, res) => { void (async () => {
    let body = ""; for await (const part of req) body += part;
    payloads.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "synthetic", object: "chat.completion.chunk", model: "synthetic" };
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic rewrite." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  })().catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let maxTokens = 0;
  const provider: VeridisRewriteProvider = { enabled: () => true, claimRequest: () => {}, run: async input => {
    await input.generate({ messages: [{ role: "user", content: "Synthetic rewrite input" }], maxTokens, ...(maxTokens === 0 ? { useProviderDefaultMaxTokens: true } : {}) });
    return { text: input.authorDraft, changed: false, calls: 1, errors: [], version: "synthetic", commit: "a".repeat(40) };
  } };
  const f = fixture("direct", [{ text: "Synthetic original." }], { veridisRewrite: provider, veridisSdk: (_m, context, options) => streamSimple({
    api: "openai-completions", provider: "synthetic", id: "synthetic", name: "Synthetic", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }, context as never, { ...options, apiKey: "synthetic-only" }) as never });
  try {
    await f.engine.performTurn("Continue.");
    const id = replies(f.sm)[0].id;
    assert.ok(id);
    assert.equal(payloads.length, 1);
    await f.engine.retryVeridisRewrite(f.sm.getSessionId(), id);
    maxTokens = 512;
    await f.engine.retryVeridisRewrite(f.sm.getSessionId(), id);
    assert.equal(payloads.length, 3);
    for (const payload of payloads.slice(0, 2)) {
      assert.equal(Object.hasOwn(payload, "max_tokens"), false);
      assert.equal(Object.hasOwn(payload, "max_completion_tokens"), false);
    }
    assert.equal(payloads[2].max_tokens, 512);
    maxTokens = 0;
    f.sm.appendCustomEntry("rp-veridis-rewrite", { version: 1, sourceEntryId: id, status: "failed", error: "Synthetic interrupted rewrite" });
    f.sm.flush();
    await f.engine.retryPendingSettlement();
    assert.equal(payloads.length, 4, "pending recovery propagates the same explicit omission");
    assert.equal(Object.hasOwn(payloads[3], "max_tokens"), false);
    for (const request of f.requests.filter(r => r.model !== "veridisRewrite")) assert.equal(request.options?.useProviderDefaultMaxTokens, undefined);
  } finally { f.cleanup(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Veridis-only retry appends only projection/diagnostics, with managed usage and no pending recovery", async () => {
	let claims = 0;
	const ended: any[] = [];
	const forbidden = async () => { throw Error("Other settlement domain must not run"); };
	const provider: VeridisRewriteProvider = { enabled: () => true, claimRequest: (_scope, guard) => { guard(); claims++; }, run: async input => {
		assert.equal(input.authorDraft, "Original synthetic prose.<options>Stay</options>");
		assert.equal(input.narrative, "Original synthetic prose.");
		await input.generate({ messages: [{ role: "system", content: "Synthetic rewrite instructions" }, { role: "user", content: "Synthetic rewrite input" }], maxTokens: 512, temperature: 0.7 });
		return { text: input.authorDraft.replace("Original", "Rewritten"), changed: true, calls: 1, errors: [], version: "3.5", commit: "a".repeat(40) };
	} };
	const f = fixture("direct", [], { ecology: true, world: true, veridisRewrite: provider, events: { onTurnEnd: info => ended.push(info) },
		databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 10, before: forbidden, after: forbidden },
		tavernPlugins: { enabled: () => true, before: forbidden, after: forbidden } });
	try {
		const id = f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original synthetic prose." }], stopReason: "stop", details: { rpGenerationMode: "direct", rpNarrative: "Original synthetic prose.", rpAuthorDraft: "Original synthetic prose.<options>Stay</options>" } } as never);
		f.sm.appendCustomEntry("rp-presentation-delivery", { targetEntryId: id, version: 1, display: "Original synthetic prose.<options>Stay</options>" });
		f.sm.appendCustomEntry("rp-turn-settlement", { narrativeEntryId: id, status: "pending", ledger: "pending", world: "pending", ecology: "pending", memory: "pending" });
		f.sm.appendCustomEntry("rp-veridis-rewrite", { version: 1, sourceEntryId: id, status: "skipped" }); f.sm.flush();
		const before = structuredClone(f.sm.getBranch());
		assert.deepEqual(await f.engine.retryVeridisRewrite(f.sm.getSessionId(), id), { aborted: false });
		assert.equal(claims, 1); assert.deepEqual(f.requests.map(r => r.model), ["veridisRewrite"]);
		const after = f.sm.getBranch(); assert.deepEqual(after.slice(0, before.length), before);
		assert.deepEqual(after.slice(before.length).map((e: any) => e.customType), ["rp-veridis-rewrite", "rp-model-diagnostics"]);
		assert.equal((after.at(-2) as any).data.sourceEntryId, id); assert.equal((after.at(-2) as any).data.status, "complete");
		assert.equal((after.at(-1) as any).data.calls[0].step, "veridisRewrite");
		const records = new RequestJournal(f.cwd).list({ sessionId: f.sm.getSessionId(), card: "card.json" }, new Set([id]));
		assert.equal(records.length, 1); assert.equal(records[0].phase, "settlement.rewrite"); assert.equal(records[0].usageSource, "provider-sdk"); assert.equal(records[0].usage?.input, 10);
		assert.deepEqual(ended, [{ aborted: false }]); assert.equal(f.engine.isStreaming, false);
	} finally { f.cleanup(); }
});

for (const stale of ["cancel", "branch", "card", "session"] as const) test(`Veridis-only retry rejects late ${stale} results`, async () => {
	let f: ReturnType<typeof fixture>;
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => started = r);
	const provider: VeridisRewriteProvider = { enabled: () => true, claimRequest: () => {}, run: async input => {
		started(); await gate;
		return { text: input.authorDraft, changed: false, calls: 0, errors: [], version: "3.5", commit: "a".repeat(40) };
	} };
	f = fixture("direct", [], { veridisRewrite: provider });
	try {
		const id = f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic prose." }], stopReason: "stop", details: { rpGenerationMode: "direct", rpNarrative: "Synthetic prose.", rpAuthorDraft: "Synthetic prose." } } as never);
		f.sm.appendCustomEntry("rp-presentation-delivery", { targetEntryId: id, version: 1, display: "Synthetic prose." }); f.sm.flush();
		const task = f.engine.retryVeridisRewrite(f.sm.getSessionId(), id); await ready;
		assert.equal(f.engine.isStreaming, true);
		assert.ok((await f.engine.retryVeridisRewrite(f.sm.getSessionId(), id)).error);
		if (stale === "cancel") f.engine.abort();
		if (stale === "branch") f.sm.branch(id);
		if (stale === "card") writeFileSync(join(f.cwd, "liyuan.config.json"), JSON.stringify({ card: "other.json" }));
		if (stale === "session") f.sm.getSessionId = () => "changed-session";
		release(); assert.ok((await task).error);
		assert.equal(f.sm.getBranch().some((e: any) => e.customType === "rp-veridis-rewrite"), false);
		assert.equal(f.requests.length, 0); assert.equal(f.engine.isStreaming, false);
	} finally { release(); f.cleanup(); }
});

test("Veridis-only retry rejects missing/stale bindings and incomplete or older drafts without requests", async () => {
	let runs = 0;
	const f = fixture("direct", [], { veridisRewrite: { enabled: () => true, claimRequest: () => {}, run: async () => { runs++; throw Error("must not run"); } } });
	try {
		const session = f.sm.getSessionId();
		for (const stopReason of ["aborted", "error", "length", "stop"]) {
			const id = f.sm.appendMessage({ role: "assistant", content: [], stopReason, details: { rpGenerationMode: "direct", rpNarrative: "Synthetic partial.", rpAuthorDraft: "Synthetic partial." } } as never);
			assert.ok((await f.engine.retryVeridisRewrite(session, id)).error);
		}
		const id = replies(f.sm).at(-1).id;
		f.sm.appendCustomEntry("rp-presentation-delivery", { targetEntryId: id, version: 1, display: "Synthetic partial." });
		for (const [expectedSession, expectedSource] of [["", id], [session, ""], ["other-session", id], [session, replies(f.sm)[0].id]])
			assert.ok((await f.engine.retryVeridisRewrite(expectedSession, expectedSource)).error);
		assert.equal(runs, 0); assert.equal(f.requests.length, 0);
	} finally { f.cleanup(); }
});

test('entry selection precedes marker/system/injection/tool assembly; generation before runs once',async()=>{
 const phases:string[]=[],notifications:string[]=[];
 const f=fixture('direct',[{text:'Synthetic complete story.'}],{events:{onNotify:(_level,text)=>notifications.push(text)},tavernPlugins:{enabled:()=>true,before:async(packet:any)=>{if(packet.worldbookEntries){phases.push('entries');assert.equal(packet.systemPrompt,'');assert.equal(packet.card,'card.json');return {...packet,retainedWorldbookIndices:packet.worldbookEntries.map((_:any,i:number)=>i).filter((i:number)=>packet.worldbookEntries[i].comment!=='native-filter-target')};}phases.push('generation');assert.ok(!JSON.stringify(packet).includes('FILTERED_UPDATE_RULE'));return packet;},after:async()=>{phases.push('after');}}});
 try{writeFileSync(join(f.cwd,'card.json'),JSON.stringify({data:{name:'云澜',description:'Synthetic card',first_mes:'Synthetic greeting',character_book:{entries:[{id:1,comment:'native-filter-target',content:'FILTERED_UPDATE_RULE',constant:true,enabled:true,keys:[]},{id:2,comment:'ordinary',content:'ORDINARY_LORE',constant:true,enabled:true,keys:[]}]}}}));await f.engine.performTurn('Continue.',{generationMode:'direct'});const request=f.requests.find(r=>r.model==='writer');assert.ok(request,notifications.join('\n'));assert.ok(JSON.stringify(request.context).includes('ORDINARY_LORE'));assert.ok(!JSON.stringify(request.context).includes('FILTERED_UPDATE_RULE'));assert.deepEqual(phases,['entries','generation','after']);assert.ok(readFileSync(join(f.cwd,'card.json'),'utf8').includes('FILTERED_UPDATE_RULE'));}finally{f.cleanup();}
});

for(const stale of ['cancel','card','branch'])test(`worldbook filter await rejects ${stale} before any writer call`,async()=>{
 let f:any;f=fixture('direct',[{text:'Must not be generated'}],{tavernPlugins:{enabled:()=>true,before:async(packet:any)=>{assert.ok(packet.worldbookEntries);if(stale==='cancel')f.engine.abort();if(stale==='card')writeFileSync(join(f.cwd,'liyuan.config.json'),JSON.stringify({card:'other.json',generationMode:'direct'}));if(stale==='branch')f.sm.branch(null);return {...packet,retainedWorldbookIndices:[]};},after:async()=>{}}});
 try{f.sm.appendCustomEntry('synthetic-anchor',{});await f.engine.performTurn('Continue.',{generationMode:'direct'});assert.equal(f.requests.length,0);}finally{f.cleanup();}
});

for (const mode of ["direct", "director"] as const) for (const supportsTools of [true, false]) for (const success of [true, false]) {
 test(`${mode}/${supportsTools}: transport partial recovery ${success ? "settles once" : "never settles incomplete draft"}`, async () => {
  const raw = '<content>合成原稿。\n  ', suffix = '同一拍结束。</content>';
  const setup = mode === "direct" ? [] : supportsTools ? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }]
   : [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "对话" }, { role: "idea-b", task: "事务" }] }) }];
  const finish = mode === "direct" ? [] : supportsTools ? [consult("review"), { calls: [{ name: "finalize" }] }] : [{ text: '{"decision":"keep"}' }];
  const ready: string[] = [], after: string[] = [];
  const f = fixture(mode, [...setup, { text: raw, error: "Stream timeout" }, ...(success ? [{ text: JSON.stringify({ suffix }) }, ...finish] : [{ text: "坏回执一" }, { text: "坏回执二" }])], {
   supportsTools, events: { onAuthorReady: info => ready.push(info.entryId) },
   databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12, before: async text => ({ userInput: text, worldbookEntries: [] }), after: async id => { after.push(id!); } },
  });
  try {
   await f.engine.performTurn("完整合成输入。", { generationMode: mode });
   const saved = replies(f.sm); assert.equal(saved.length, 1);
   assert.equal(saved[0].message.details.rpAuthorDraft, success ? raw + suffix : raw);
   assert.equal(saved[0].message.stopReason, success ? "stop" : "aborted");
   assert.equal(ready.length, success ? 1 : 0); assert.equal(after.length, success ? 1 : 0);
   assert.equal(f.requests.filter(r => r.model === "scribe").length, success ? 1 : 0);
   assert.equal(f.sm.getBranch().filter((e:any) => e.customType === "rp-presentation-delivery").length, success ? 1 : 0);
   assert.equal(f.requests.filter(isPrimaryWriterRequest).length, setup.length + (success ? 2 + finish.length : 3));
  } finally { f.cleanup(); }
 });
}

test("直出模式保留正常文学导演，读旧记忆生态，正文为普通文本且无画像/脑暴/审稿", async () => {
	const text = '“第二天再谈。”沈舟走向教室的窗边。' + "他继续说明桌上的账目。".repeat(27);
	const f = fixture("direct", [{ text }]);
	try {
		await f.engine.performTurn("继续。");
		assert.deepEqual(f.requests.filter(x => x.context.systemPrompt !== SUPPLEMENTARY_PROTOCOL).map(x => x.model), ["literaryDirector", "writer", "scribe"]);
		assert.equal(f.requests.filter(x => x.context.systemPrompt === SUPPLEMENTARY_PROTOCOL).length, 0, "no output requirements means no supplementary request");
		assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-supplementary-delivery").at(-1) as any).data.status, "skipped");
		const writer = f.requests.find(x => x.model === "writer");const payload = JSON.stringify(writer.context);
		assert.match(payload, /本拍文学导演候选/);assert.match(payload, /一起核对账目/);
		assert.doesNotMatch(payload, /Sogon|用户偏好参考|本拍还没有计划|每个路标落笔前/);
		assert.ok(!writer.context.tools?.some((x: any) => ["draft_append", "beat_plan", "ask"].includes(x.name)));
		const entry = replies(f.sm)[0];assert.equal(entry.message.details.rpNarrative, text);assert.equal(entry.message.details.rpGenerationMode, "direct");
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-state" && e.data.location === "书房"));
		const wire = toWireMsg(entry.message, { charName: "云澜", userName: "沈舟" });assert.equal(wire?.generationMode, "direct");assert.equal(wire?.generationWorkflow?.mode, "direct");
	} finally { f.cleanup(); }
});

test("完整导演每拍固定3/2/2，无独立文学导演及心理画像，唯主writer文字落树", async () => {
	const f = fixture("director", directorScript("同一个作者完成的定稿。"));
	try {
		await f.engine.performTurn("只是继续聊聊。");
		assert.equal(f.requests.filter(x => x.model !== "writer" && x.model !== "scribe").length, 7);
		assert.equal(f.requests.filter(x => x.model === "literaryDirector").length, 0);
		assert.equal(f.requests.filter(x => x.model === "directorIdeas").length, 2);
		const reply = replies(f.sm)[0];assert.equal(reply.message.details.rpNarrative, "同一个作者完成的定稿。");
		assert.deepEqual(reply.message.details.rpGenerationWorkflow.stages.filter((x: any) => ["evidence", "ideas", "review"].includes(x.stage)).map((x: any) => x.calls), [3, 2, 2]);
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.status === "complete"));
	} finally { f.cleanup(); }
});

for (const world of [false, true]) for (const ecology of [false, true]) for (const supportsTools of [false, true]) {
	test(`director retained evidence obeys independent enable flags: world=${world}, ecology=${ecology}, tools=${supportsTools}`, async () => {
		const body = "Synthetic current story.";
		const responses = supportsTools ? directorScript(body) : [
			{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "Synthetic A" }, { role: "idea-b", task: "Synthetic B" }] }) },
			{ text: body }, { text: '{"decision":"keep"}' },
		];
		const f = fixture("director", responses, { world, ecology, supportsTools });
		try {
			const retainedWorld = { version: 2, round: 2, digest: "RETAINED_WORLD_SENTINEL", kernel: { links: [] }, modules: {} };
			const retainedEcology = { version: 1, round: 2, actors: [{ id: "keeper", name: "Synthetic keeper", activity: "RETAINED_ECOLOGY_SENTINEL", location: "Archive" }], occurrences: [] };
			f.sm.appendCustomEntry("rp-world-state", retainedWorld);
			f.sm.appendCustomEntry("rp-ecology-state", retainedEcology);
			f.sm.flush();
			await f.engine.performTurn("Continue.");
			const reports = f.requests.filter(r => ["literaryContinuity", "directorSetting", "ecologyRuntime", "directorIdeas", "directorReviewFacts", "directorReviewStyle"].includes(r.model))
				.map(r => JSON.parse(promptMessageText(r.context.messages.find((m: any) => m.role === "user"))))
				.filter(payload => payload.role);
			assert.equal(reports.length, 7, "disabled simulation must preserve director 3/2/2 reports");
			for (const payload of reports) {
				assert.equal(JSON.stringify(payload).includes("RETAINED_WORLD_SENTINEL"), world);
				assert.equal(payload.context.sources.some((s: any) => s.id === "world"), world);
				assert.equal(Object.hasOwn(payload.context, "world"), world);
				const ecologyVisible = ecology && ["ecology", "idea-a", "idea-b", "review-facts"].includes(payload.role);
				assert.equal(JSON.stringify(payload).includes("RETAINED_ECOLOGY_SENTINEL"), ecologyVisible);
				assert.equal(payload.context.sources.some((s: any) => s.id === "ecology"), ecologyVisible);
				assert.equal(Object.hasOwn(payload.context, "ecology"), ecologyVisible);
			}
			assert.equal(replies(f.sm)[0].message.details.rpNarrative, body);
			assert.deepEqual((f.sm.getBranch().find((e: any) => e.customType === "rp-world-state") as any).data, retainedWorld);
			assert.deepEqual((f.sm.getBranch().find((e: any) => e.customType === "rp-ecology-state") as any).data, retainedEcology);
		} finally { f.cleanup(); }
	});
}

test("每条输入模式固定，下一条可切换，同一会话事实账本继续使用", async () => {
	const f = fixture("direct", [{ text: "直出原文。" }, ...directorScript("导演新原文。")]);
	try {
		await f.engine.performTurn("第一拍。", { generationMode: "direct" });
		await f.engine.performTurn("第二拍。", { generationMode: "director" });
		assert.deepEqual(replies(f.sm).map((x: any) => x.message.details.rpGenerationMode), ["direct", "director"]);
		const secondWriter = f.requests.filter(isPrimaryWriterRequest)[1];assert.match(JSON.stringify(secondWriter.context), /直出原文/);assert.match(JSON.stringify(secondWriter.context), /书房/);
	} finally { f.cleanup(); }
});

test("未结算半稿保留，下一输入不得恢复后台或开新拍", async () => {
	const f = fixture("direct", [{ text: "沈舟来到书房。", aborted: true }, { text: "他继续核对账目。" }]);
	try {
		await f.engine.performTurn("先进去。");
		assert.equal(replies(f.sm)[0].message.stopReason, "aborted");assert.equal(f.requests.filter(x => x.model === "scribe").length, 0);
		await f.engine.performTurn("继续。");
		assert.equal(f.requests.filter(x => x.model === "writer").length, 1);
		assert.equal(f.requests.filter(x => x.model === "scribe").length, 0);
		assert.equal(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.recovered === true), false);
	} finally { f.cleanup(); }
});

test("半稿后台始终不受理新输入，即使场记恢复可用", async () => {
	const f = fixture("direct", [{ text: "保留的半稿", aborted: true }, { text: "恢复后的新正文" }]);
	try {
		await f.engine.performTurn("开始。");f.setLedgerFail(true);let accepted = 0;
		await f.engine.performTurn("不应受理的新输入", { clientMessageId: "pending-input", onAccepted: () => accepted++ });
		assert.equal(accepted, 0);assert.ok(!JSON.stringify(f.sm.getBranch()).includes("不应受理的新输入"));
		f.setLedgerFail(false);await f.engine.performTurn("恢复后继续。");assert.equal(replies(f.sm).length, 1);assert.equal(f.requests.filter(x=>x.model==="scribe").length,0);
	} finally { f.cleanup(); }
});

test("新模式配置不再写回ask/profile/guided旧创作开关", () => {
	const next = applyConfigPatch({ ...DEFAULT_CONFIG, creationMode: "ask", literaryQuality: "guided" } as never, { generationMode: "direct" });
	assert.equal(next.generationMode, "direct");assert.equal(Object.hasOwn(next, "creationMode"), false);assert.equal(next.literaryQuality, undefined);assert.equal(next.literaryProfileEveryNTurns, undefined);
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { generationMode: "unknown" }).generationMode, "director");
});


test("已结算领域的checkpoint恢复不重复记账或推进世界", async () => {
	const f = fixture("direct", [{ text: "第一拍完整正文。" }, { text: "第二拍完整正文。" }]);
	try {
		await f.engine.performTurn("第一拍。");
		const id = replies(f.sm)[0].id;
		f.sm.appendCustomEntry("rp-turn-settlement", { version: 1, narrativeEntryId: id, status: "settling", ledgerDone: true, worldDone: true, ecologyDone: true }); f.sm.flush();
		const before = f.requests.filter(x => x.model === "scribe").length;
		await f.engine.performTurn("第二拍。");
		assert.equal(f.requests.filter(x => x.model === "scribe").length, before + 1, "只结算第二拍，不重复累计第一拍");
	} finally { f.cleanup(); }
});

test("旧配置和旧客户端均不能重新启用 creationMode ask", () => {
	const next = applyConfigPatch({ ...DEFAULT_CONFIG, creationMode: "ask" } as never, { creationMode: "ask", scanDepth: 7 });
	assert.equal(Object.hasOwn(next, "creationMode"), false);
	assert.equal(next.scanDepth, 7);
});


test("新模式生态仅采纳完整已保存正文，半稿不得变成承诺事实", async () => {
	for (const stopped of [false, true]) {
		const body = "沈舟答应明天去图书馆帮忙。";
		const f = fixture("direct", [{ text: body, ...(stopped ? { aborted: true } : {}) }, { text: "然后继续手上的工作。" }], { ecology: true });
		try {
			await f.engine.performTurn("继续");
			if (stopped) await f.engine.performTurn("接着来");
			const snapshots = f.sm.getBranch().filter((e: any) => e.customType === "rp-ecology-state");
			if (stopped) { assert.equal(snapshots.length, 0); continue; }
			const accepted = snapshots.find((e: any) => e.data.occurrences.some((o: any) => o.userCommitment?.quote === body));
			assert.ok(accepted, "ordinary settlement and recovery must both accept the saved fictional commitment");
			assert.equal((accepted as any).data.occurrences[0].userRole, "committed");
			assert.equal((accepted as any).data.occurrences[0].userCommitment.sourceEntryId, replies(f.sm)[0].id);
		} finally { f.cleanup(); }
	}
});


test("直出卡嵌套main_output/content且末尾格式未闭合，原作者接续后才保存和结算", async () => {
	const body = "沈舟把练习册推到桌子另一边。云澜圈出了被忽略的条件。";
	const raw = `<main_output><content><time>午休</time>${body}<image><imgthink>未完成的格式`;
	const suffix = "</imgthink></image></content></main_output>";
	const f = fixture("direct", [{ text: raw }, { text: JSON.stringify({ suffix }) }]);
	try {
		await f.engine.performTurn("继续讨论题目。", { generationMode: "direct" });
		assert.ok(replies(f.sm)[0]?.message.details.rpNarrative.startsWith(body));
		assert.equal(replies(f.sm)[0]?.message.details.rpAuthorDraft, raw + suffix);
		assert.equal(f.requests.filter(isPrimaryWriterRequest).length, 2);
		assert.ok(f.requests.some(x => x.model === "scribe"), "不能把已写成正文报告为空稿而跳过结算");
		assert.ok(f.sm.getBranch().some((e: any) => e.customType === "rp-turn-settlement" && e.data.status === "complete"));
	} finally { f.cleanup(); }
});


test("结构化旁路尊重原模型流式配置，不无条件改为非流式", async () => {
	for (const sideStreaming of [undefined, true, false]) {
		const f = fixture("direct", [{ text: "保存正常正文。" }], { sideStreaming });
		try {
			await f.engine.performTurn("继续。");
			const director = f.requests.find(x => x.model === "literaryDirector");
			const scribe = f.requests.find(x => x.model === "scribe");
			assert.equal(director?.compat.streaming, sideStreaming);
			assert.equal(scribe?.compat.streaming, sideStreaming);
		} finally { f.cleanup(); }
	}
});

test("恢复不永久沿用旧world失败标记，已提交领域不重复模型调用", async()=>{
 const f=fixture("direct",[{text:"已经保存的正文。"},{text:"下一拍正常正文。"}]);try{
  await f.engine.performTurn("开始。",{generationMode:"direct"});const id=replies(f.sm)[0].id;
  f.sm.appendCustomEntry("rp-world-state",{version:2,round:1,digest:"已提交",kernel:{lastAuditHash:"abc",links:[]},modules:{},_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry("rp-turn-settlement",{version:1,narrativeEntryId:id,status:"pending",ledgerDone:true,worldDone:false,ecologyDone:true,degradedDomains:["world"]});f.sm.flush();
  const before=f.requests.length;const result=await f.engine.retryPendingSettlement();assert.equal(result.error,undefined);assert.equal(f.requests.length,before,"已提交领域的收据修复不再烧API");
  const receipt=[...f.sm.getBranch()].reverse().find((e:any)=>e.customType==="rp-turn-settlement")?.data as any;assert.equal(receipt.status,"complete");assert.deepEqual(receipt.degradedDomains,[]);assert.equal(receipt.worldDone,true);
 }finally{f.cleanup()}
});


test("模型工具能力默认支持，显式勾选仍保留原生工具通道", async () => {
	for (const supportsTools of [undefined, true]) {
		const f = fixture("direct", [{ text: "合成默认工具正文。" }], { supportsTools });
		try {
			await f.engine.performTurn("合成输入。");
			const writer = f.requests.find(x => x.model === "writer");
			assert.ok(writer.context.tools?.length > 0);
			assert.equal(replies(f.sm)[0].message.details.rpGenerationWorkflow.toolFallback, false);
		} finally { f.cleanup(); }
	}
});

test("取消支持工具调用后，直出实际请求无tools且保持当前模型", async () => {
	const f = fixture("direct", [{ text: "合成纯文本正文。" }], { supportsTools: false });
	try {
		await f.engine.performTurn("合成输入。");
		const writer = f.requests.filter(x => x.model === "writer");
		assert.ok(writer.length > 0);
		for (const request of writer) assert.equal(Object.hasOwn(request.context, "tools"), false);
		const workflow = replies(f.sm)[0].message.details.rpGenerationWorkflow;
		assert.equal(workflow.mode, "direct");
		assert.equal(workflow.toolFallback, true);
		assert.equal(workflow.toolFallbackReason, "configured");
		assert.equal(replies(f.sm)[0].message.details.rpNarrative, "合成纯文本正文。");
	} finally { f.cleanup(); }
});

test("取消支持工具调用后，导演仍执行固定3/2/2而不切直出", async () => {
	const f = fixture("director", [
		{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "合成角度一" }, { role: "idea-b", task: "合成角度二" }] }) },
		{ text: "合成无原生工具的导演正文。" }, { text: '{"decision":"keep"}' },
	], { supportsTools: false });
	try {
		await f.engine.performTurn("合成输入。");
		for (const request of f.requests) assert.equal(Object.hasOwn(request.context, "tools"), false);
		const reply = replies(f.sm)[0];
		assert.equal(reply.message.details.rpNarrative, "合成无原生工具的导演正文。");
		const workflow = reply.message.details.rpGenerationWorkflow;
		assert.equal(workflow.mode, "director");
		assert.equal(workflow.toolFallbackReason, "configured");
		assert.deepEqual(workflow.stages.filter((x: any) => ["evidence", "ideas", "review"].includes(x.stage)).map((x: any) => x.calls), [3, 2, 2]);
		assert.equal(f.requests.filter(x => !["writer", "scribe"].includes(x.model)).length, 7);
	} finally { f.cleanup(); }
});


test("原数据库接线：拍前投送、已落树规范正文拍后整理、旧自动压缩不再双写", async () => {
	const body='青梧把铜钥匙收好，记下了未兑现的归还约定。'+"两人确认了眼前的安排。".repeat(25);
	const calls: string[]=[];let f:ReturnType<typeof fixture>;
	f=fixture("direct",[{text:body}],{databasePluginMemory:{enabled:()=>true,before:async text=>{calls.push("before");assert.equal(text,"继续。");return pluginBeforeResult(text)},after:async id=>{calls.push("after");const entry=f.sm.getBranch().find(e=>e.id===id) as any;assert.equal(entry.message.details.rpNarrative,body);},recentHistoryMessages:()=>12}});
	try{await f.engine.performTurn("继续。");assert.deepEqual(calls,["before","after"]);assertDatabaseRecallRequest(f.requests,"继续。");assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="complete"));assert.ok(!f.requests.some(r=>r.model==="compaction"||r.model==="memoryEvents"));assert.deepEqual(await f.engine.compactNow(),{kind:"skipped",reason:"upstream-plugin-managed"});}finally{f.cleanup()}
});

test("插件拍前失败时不调用writer或after，且提交的user原文不污染", async () => {
	let beforeCalls=0,afterCalls=0;
	const f=fixture("direct",[{text:"不应生成的正文。"}],{databasePluginMemory:{enabled:()=>true,before:async()=>{beforeCalls++;throw new Error("synthetic before failure")},after:async()=>{afterCalls++},recentHistoryMessages:()=>12}});
	try{
		await f.engine.performTurn("原始输入。").catch(()=>undefined);
		assert.equal(beforeCalls,1);assert.equal(afterCalls,0);
		assert.equal(f.requests.filter(request=>request.model==="writer").length,0);
		const users=f.sm.getBranch().filter((entry:any)=>entry.type==="message"&&entry.message.role==="user");
		assert.equal(promptMessageText(users.at(-1)?.message),"原始输入。");
	}finally{f.cleanup()}
});

test("原数据库失败不重写已保存故事：留下pending并在下一拍前恢复一次", async () => {
	const first='青梧收下铜钥匙，承诺明日归还。'+"两人确认了眼前的安排。".repeat(25),second='青梧核对了昨天的约定，没有把它当作已经兑现。'+"她继续说明归还的安排。".repeat(25);
	let fail=true;const ids:string[]=[];
	const f=fixture("direct",[{text:first},{text:second}],{databasePluginMemory:{enabled:()=>true,before:async text=>({userInput:recalledUserInput(text),worldbookEntries:[]}),after:async id=>{ids.push(id!);if(fail){fail=false;throw new Error("synthetic memory failure")}},recentHistoryMessages:()=>12}});
	try{await f.engine.performTurn("收下钥匙。");const saved=replies(f.sm)[0];assert.equal(saved.message.details.rpNarrative,first);assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="pending"));await f.engine.performTurn("核对约定。");assert.equal(replies(f.sm).length,2);assert.deepEqual(ids.slice(0,2),[saved.id,saved.id]);assert.equal(ids.length,3);assert.equal(f.sm.getBranch().find((entry:any)=>entry.id===saved.id)?.message.details.rpNarrative,first);assert.deepEqual(f.sm.getBranch().filter((entry:any)=>entry.type==="message"&&entry.message.role==="user").map((entry:any)=>promptMessageText(entry.message)),["收下钥匙。","核对约定。"]);}finally{f.cleanup()}
});

for (const mode of ["direct", "director"] as const) test(`${mode}: database pending blocks the next input before persistence and ACK`, async () => {
 let failing = true, accepted = 0;
 const ended: any[] = [];
 const first = "Synthetic saved first story.", second = "Synthetic saved second story.";
 const script = mode === "direct" ? [{text:first}, {text:second}] : [...directorScript(first), ...directorScript(second)];
 const f = fixture(mode, script, {events:{onTurnEnd:info=>ended.push(info)}, databasePluginMemory:{enabled:()=>true, before:async text=>pluginBeforeResult(text), after:async()=>{if(failing)throw Error("synthetic pending memory");}, recentHistoryMessages:()=>12}});
 try {
  await f.engine.performTurn("First synthetic input.");
  const saved = replies(f.sm)[0], before = f.requests.length;
  await f.engine.performTurn("Second synthetic input.", {clientMessageId:"blocked-database-input", onAccepted:()=>accepted++});
  assert.equal(accepted, 0);
  assert.match(ended.at(-1)?.error ?? "", /synthetic pending memory/);
  assert.equal(f.requests.length, before, "no new author or already-completed domain is called");
  assert.equal(replies(f.sm).length, 1);
  assert.ok(!f.sm.getBranch().some((e:any)=>e.message?.role==="user"&&e.message.details?.rpClientMessageId==="blocked-database-input"));
  assert.equal(replies(f.sm)[0].message.details.rpAuthorDraft, saved.message.details.rpAuthorDraft);
  failing = false;
  await f.engine.performTurn("Second synthetic input.", {clientMessageId:"blocked-database-input", onAccepted:()=>accepted++});
  assert.equal(accepted, 1);
  assert.equal(replies(f.sm).length, 2);
 } finally { f.cleanup(); }
});

for (const sourceKind of ["missing", "user", "partial"] as const) test(`database recovery rejects ${sourceKind} source before requests`, async () => {
 let afterCalls = 0;
 const f = fixture("direct", [], {databasePluginMemory:{enabled:()=>true, before:async text=>pluginBeforeResult(text), after:async()=>{afterCalls++;}, recentHistoryMessages:()=>12}});
 try {
  let source = "synthetic-missing-entry";
  if (sourceKind !== "missing") source = f.sm.appendMessage({role:sourceKind === "user" ? "user" : "assistant", content:[{type:"text",text:"Synthetic partial input."}], stopReason:"aborted", details:{rpNarrative:"Synthetic partial story."}} as never);
  f.sm.appendCustomEntry("rp-database-memory", {sourceEntryId:source,status:"pending"}); f.sm.flush();
  const before = structuredClone(f.sm.getBranch());
  const result = await f.engine.retryPendingSettlement();
  assert.match(result.error ?? "", /完整正文/);
  assert.equal(afterCalls, 0);
  assert.deepEqual(f.sm.getBranch(), before);
 } finally { f.cleanup(); }
});

for (const change of ["cancel", "branch", "card"] as const) test(`explicit database recovery discards late ${change} completion`, async () => {
 let f: ReturnType<typeof fixture>, fail = true;
 f = fixture("direct", [{text:"Synthetic saved complete story."}], {databasePluginMemory:{enabled:()=>true, before:async text=>pluginBeforeResult(text), after:async()=>{
  if(fail)throw Error("synthetic first failure");
  if(change==="cancel") f.engine.abort();
  if(change==="branch") f.sm.branch((f.sm.getBranch().find((e:any)=>e.message?.role==="user") as any).id);
  if(change==="card") writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify({card:"other.json",generationMode:"direct"}));
 },recentHistoryMessages:()=>12}});
 try {
  await f.engine.performTurn("First synthetic input.");const anchor=f.sm.getLeafId();fail=false;
  const result=await f.engine.retryPendingSettlement();assert.match(result.error ?? "", /取消或来源改变/);
  if(change==="branch") f.sm.branch(anchor);
  assert.equal(replies(f.sm).length,1);
  assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="complete").length,0);
 } finally { f.cleanup(); }
});

test("显式恢复仅数据库pending：失败保留收据，成功不重复正文或已完成领域",async()=>{
 let fail=true,afterCalls=0;
 const f=fixture("direct",[{text:"合成完整正文。"+"两人继续确认安排。".repeat(25)}],{databasePluginMemory:{enabled:()=>true,before:async text=>pluginBeforeResult(text),after:async()=>{afterCalls++;if(fail)throw Error("synthetic memory failure")},recentHistoryMessages:()=>12}});
 try{
  await f.engine.performTurn("继续。");const saved=replies(f.sm)[0],requestCount=f.requests.length;
  assert.match((await f.engine.retryPendingSettlement()).error??"",/synthetic memory failure/);
  assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==="rp-database-memory").at(-1)?.data.status,"pending");
  fail=false;assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
    assert.equal(afterCalls,3);assert.equal(replies(f.sm).length,1);assert.equal(f.requests.length,requestCount);
  assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==="rp-database-memory").at(-1)?.data.status,"complete");
  assert.ok(!(f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1)?.data.degradedDomains??[]).includes("memory"));
    await f.engine.retryPendingSettlement();assert.equal(afterCalls,3);assert.equal(replies(f.sm)[0].message.details.rpNarrative,saved.message.details.rpNarrative);
 }finally{f.cleanup()}
});

test("原插件交火召回以原文和条目元数据进入direct正式请求", async () => {
	const input="原始输入。",body="直出作者完成的合成正文。"+"两人继续核对眼前安排。".repeat(25),events:string[]=[];
	let f:ReturnType<typeof fixture>;
	f=fixture("direct",[{text:body}],{databasePluginMemory:{enabled:()=>true,before:async text=>{events.push("before");assert.equal(text,input);return pluginBeforeResult(text)},after:async id=>{events.push("after");assert.equal((f.sm.getBranch().find((entry:any)=>entry.id===id) as any)?.message.details.rpNarrative,body)},recentHistoryMessages:()=>12,events}});
	try{
		await f.engine.performTurn(input);
		assertDatabasePluginOrder(events);
		const request=assertDatabaseRecallRequest(f.requests,input);assert.equal(request.model,"writer");
		const users=f.sm.getBranch().filter((entry:any)=>entry.type==="message"&&entry.message.role==="user");assert.equal(promptMessageText(users.at(-1)?.message),input);
	}finally{f.cleanup()}
});

test("原插件交火召回进入director正式请求与专家来源，原始user事实保持不变", async () => {
	const input="原始输入。",body="导演主作者完成的合成定稿。"+"两人继续核对眼前安排。".repeat(25),events:string[]=[];
	let f:ReturnType<typeof fixture>;
	f=fixture("director",directorScript(body),{databasePluginMemory:{enabled:()=>true,before:async text=>{events.push("before");assert.equal(text,input);return pluginBeforeResult(text)},after:async id=>{events.push("after");assert.equal((f.sm.getBranch().find((entry:any)=>entry.id===id) as any)?.message.details.rpNarrative,body)},recentHistoryMessages:()=>12,events}});
	try{
		await f.engine.performTurn(input);
		assertDatabasePluginOrder(events);
		assertDatabaseRecallRequest(f.requests,input);
		const experts=f.requests.filter(request=>request.model!=="writer"&&request.model!=="scribe");
		assert.ok(experts.length>0);assert.ok(experts.some(request=>JSON.stringify(request.context).includes("<recall>AM0001|Xd</recall>")),"director expert request sources must include recalled AM material");
		for(const request of experts)assert.doesNotMatch(JSON.stringify(request.context),/AM0002|禁用纪要索引/);
		const users=f.sm.getBranch().filter((entry:any)=>entry.type==="message"&&entry.message.role==="user");assert.equal(promptMessageText(users.at(-1)?.message),input);
	}finally{f.cleanup()}
});


test("导演补全回执恢复后才审阅、落树、结算生态并调用数据库after",async()=>{
 const events:string[]=[];let sm:any;
 const plugin={events,enabled:()=>true,before:async(text:string)=>{events.push("before");return pluginBeforeResult(text);},after:async(id?:string)=>{events.push("after");const entry=sm.getBranch().find((e:any)=>e.id===id);assert.equal(entry.message.stopReason,"stop");assert.ok(entry.message.details.rpGenerationWorkflow.stages.some((s:any)=>s.stage==="finalize"));},recentHistoryMessages:()=>12};
 const f=fixture("director",[consult("evidence"),consult("ideas"),{calls:[{name:"begin_narrative"}]},{text:"沈舟答应明天去",stopReason:"length"},{text:'<content>{"suffix":"图书馆帮忙。随后云澜继续整理桌上的账目。"}</content>'},consult("review"),{calls:[{name:"finalize"}]}],{ecology:true,world:true,databasePluginMemory:plugin});sm=f.sm;
 try{
  await f.engine.performTurn("核对账目后继续帮助整理图书。",{generationMode:"director"});
  const reply=replies(f.sm)[0];assert.equal(reply.message.stopReason,"stop");assert.match(reply.message.details.rpNarrative,/去图书馆帮忙/);assert.equal(reply.message.details.rpGenerationWorkflow.recovery.status,"success");
  assertDatabasePluginOrder(events);assert.equal(events.filter(e=>e==="after").length,1);
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-ecology-state"&&e.data.actors.some((a:any)=>a.activity==="整理桌上的账目")));
  assert.ok(f.requests.some(r=>r.model==="literaryWorldFacts"));assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-world-audit"&&e.data.status==="committed"));
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.sourceEntryId===reply.id&&e.data.status==="complete"));
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-turn-performance"&&e.data.phases["settlement.memory"].status==="success"));
 }finally{f.cleanup();}
});

test("两次补全回执失败时不进入review/正常生态结算或数据库after，Wire带出明确错误",async()=>{
 const events:string[]=[];
 const plugin={events,enabled:()=>true,before:async(text:string)=>{events.push("before");return pluginBeforeResult(text);},after:async()=>{events.push("after");},recentHistoryMessages:()=>12};
 const f=fixture("director",[consult("evidence"),consult("ideas"),{calls:[{name:"begin_narrative"}]},{text:"沈舟答应明天去",stopReason:"length"},{text:"坏回执一"},{text:"坏回执二"}],{ecology:true,databasePluginMemory:plugin});
 try{
  await f.engine.performTurn("继续",{generationMode:"director"});
  const reply=replies(f.sm)[0];assert.equal(reply.message.stopReason,"aborted");assert.equal(events.includes("after"),false);
  assert.equal(f.requests.filter(r=>/^directorReview/.test(r.model)).length,0);assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==="rp-ecology-state").length,0);
  const wire=toWireMsg(reply.message,{charName:"云澜",userName:"沈舟"});assert.equal(wire?.unfinished,true);assert.match(wire?.generationError??"",/输出恢复回执/);
  const receipt=f.sm.getBranch().find((e:any)=>e.customType==="rp-turn-settlement");assert.equal((receipt as any).data.authorComplete,false);assert.equal((receipt as any).data.memoryStatus,"skipped");
 }finally{f.cleanup();}
});

function cachedWorldProfile(f:ReturnType<typeof fixture>) {
 const m=loadStageMaterials(f.cwd),fp=worldProfileFingerprint({card:m.card,entries:m.entries,preset:m.preset,greetingIndex:m.config.greetingIndex});
 const profile=defaultCardWorldProfile(f.cwd,"card.json",m.card.name,fp,m.card);saveCardWorldProfile(f.cwd,"card.json",profile,m.card);return profile;
}
test("重Roll采用缓存世界画像：不在user和新assistant之间塞Manifest，实际世界留同源审计",async()=>{
 const f=fixture("direct",[{text:"新稿：她将本拍账本放回原处。"}],{world:true,worldWithoutManifest:true});
 try{
  const user=f.sm.appendMessage({role:"user",content:[{type:"text",text:"继续核对账目。"}],timestamp:Date.now()} as never);
  f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"旧版本。"}],stopReason:"stop",timestamp:Date.now(),details:{rpNarrative:"旧版本。"}} as never);
  f.sm.appendCustomEntry("rp-world-manifest",manifestFromProfile(cachedWorldProfile(f)));f.sm.flush();f.sm.branch(user);
  assert.ok(!f.sm.getBranch().some((e:any)=>e.customType==="rp-world-manifest"));
  await f.engine.regenerate();
  const reply=replies(f.sm).at(-1) as any;assert.equal(reply.parentId,user);
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-world-manifest"));
  assert.ok(f.requests.some(r=>r.model==="literaryWorldFacts"));
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-world-audit"&&e.data.narrativeEntryId===reply.id&&e.data.status==="committed"));
 }finally{f.cleanup();}
});
test("历史世界假完成+格式pending：只补缺失世界和重挂原交付，不重跑已完成生态/记忆/插件",async()=>{
 const events:string[]=[],plugin={enabled:()=>true,recentHistoryMessages:()=>4,events,before:async(text:string)=>({userInput:text,worldbookEntries:[]}),after:async()=>{events.push("after");}};
 const f=fixture("direct",[],{world:true,worldWithoutManifest:true,databasePluginMemory:plugin});
 try{
  cachedWorldProfile(f);f.sm.appendMessage({role:"user",content:[{type:"text",text:"继续。"}],timestamp:Date.now()} as never);
  const id=f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"已存本拍正文。"}],timestamp:Date.now(),stopReason:"stop",details:{rpNarrative:"已存本拍正文。",rpAuthorDraft:"<content>已存本拍正文。</content><options>继续</options>",rpGenerationMode:"direct"}} as never);
  f.sm.appendCustomEntry("rp-state",{characters:{},location:"书房",_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry("rp-ecology-state",{round:1,_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry("rp-database-memory",{sourceEntryId:id,status:"complete"});f.sm.appendCustomEntry("rp-tavern-plugin-settlement",{entryId:id,status:"complete"});
  f.sm.appendCustomEntry("rp-turn-settlement",{narrativeEntryId:id,status:"pending",ledgerDone:true,worldDone:true,ecologyDone:true,presentationDone:false,degradedDomains:["presentation"]});f.sm.flush();
  const count=(type:string)=>f.sm.getBranch().filter((e:any)=>e.customType===type).length;
  const types=["rp-state","rp-ecology-state","rp-database-memory","rp-tavern-plugin-settlement"],before=types.map(count);
  assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
  assert.deepEqual(f.requests.map(r=>r.model),["literaryWorldFacts"]);assert.equal(events.length,0);assert.deepEqual(types.map(count),before);
  const receipt=f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any;assert.equal(receipt.data.status,"complete");
  const calls=f.requests.length;await f.engine.retryPendingSettlement();assert.equal(f.requests.length,calls);
 }finally{f.cleanup();}
});
test("世界已启用却无画像不能把未运行记录成worldDone成功",async()=>{
 const f=fixture("direct",[{text:"她整理好了这一页账目。"}],{world:true,worldWithoutManifest:true});
 try{await f.engine.performTurn("继续。",{generationMode:"direct"});const receipt=f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any;assert.equal(receipt.data.status,"pending");assert.equal(receipt.data.worldDone,false);assert.ok(receipt.data.degradedDomains.includes("world"));assert.ok(!f.requests.some(r=>r.model==="literaryWorldFacts"));assert.match((await f.engine.retryPendingSettlement()).error??"",/world|画像/);}
 finally{f.cleanup();}
});


function deferred<T = void>() {
 let resolve!: (value: T | PromiseLike<T>) => void;
 const promise = new Promise<T>(done => { resolve = done; });
 return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out: " + label)), 8000); })]); }
 finally { clearTimeout(timer); }
}
for (const mode of ["direct", "director"] as const) test(`${mode}：正文和原格式先持久化交付，场记/鲜活世界/数据库均不得阻塞上屏`, { timeout: 10000 }, async () => {
 const body = '<content>她整理好了这一页账目。</content>\n<options>继续核对</options>\n<附属格式>作者原格式</附属格式>';
 const ready = deferred<string>(), memoryStarted = deferred(), releaseMemory = deferred();
 const ended: any[] = [], order: string[] = [];
 let f!: ReturnType<typeof fixture>;
 f = fixture(mode, mode === "direct" ? [{ text: body }] : directorScript(body), {
  ecology: true, world: true,
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => ({ userInput: text, worldbookEntries: [] }),
   after: async () => { order.push("memory"); memoryStarted.resolve(); await releaseMemory.promise; } },
  events: {
   onAuthorReady: ({ entryId }) => {
    order.push("ready");
    assert.equal(f.engine.isStreaming, true, "shared tree lock must survive author completion");
    assert.equal(f.engine.isSettling, true);
    assert.equal(f.requests.some(r => r.model === "scribe"), false, "author delivery precedes scribe calls");
    assert.equal(f.requests.some(r => r.model === "literaryWorldFacts"), false, "world facts are background work");
     assert.equal(f.requests.some(r => r.model === "ecologyRuntime" && JSON.parse(promptMessageText(r.context.messages[0])).phase === "aftermath"), false);
    const branch = f.sm.getBranch() as any[];
    const reply = branch.find(e => e.id === entryId);
    assert.equal(reply.message.details.rpAuthorDraft, body);
    assert.doesNotMatch(reply.message.details.rpNarrative, /附属格式|继续核对/);
    assert.equal(reply.message.stopReason, "stop");
    const delivery = branch.find(e => e.customType === "rp-presentation-delivery");
    assert.equal(delivery.data.targetEntryId, entryId);
    assert.equal(delivery.data.display, body);
    assert.equal(branch.filter(e => e.customType === "rp-turn-settlement").at(-1).data.presentationDone, true);
    assert.ok(branch.some(e => e.customType === "rp-database-memory" && e.data.sourceEntryId === entryId && e.data.status === "pending"));
    const disk = readFileSync(f.sm.getSessionFile()!, "utf8");
    assert.ok(disk.includes(delivery.id), "original formatted delivery must be on disk before ready event");
    ready.resolve(entryId);
   },
   onTurnEnd: info => { order.push("end"); ended.push(info); },
  },
 });
 const task = f.engine.performTurn("继续核对账目。");
 try {
  const id = await bounded(ready.promise, "author-ready");
  await bounded(memoryStarted.promise, "database started");
  assert.equal(ended.length, 0, "background completion is separate from author-ready");
  assert.ok(f.sm.getBranch().some((e: any) => e.id === id));
  releaseMemory.resolve(); await task;
  assert.deepEqual(order, ["ready", "memory", "end"]);
  assert.equal(f.engine.isStreaming, false); assert.equal(f.engine.isSettling, false);
  assert.equal(ended[0].entryId, id); assert.equal(ended[0].aborted, false);
  const metrics = (f.sm.getBranch().find((e: any) => e.customType === "rp-turn-performance") as any).data;
  assert.equal(typeof metrics.timeToAuthorReadyMs, "number"); assert.ok(metrics.totalMs >= metrics.timeToAuthorReadyMs);
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-presentation-delivery").length, 1);
 } finally { releaseMemory.resolve(); await task; f.cleanup(); }
});

for (const mode of ["direct", "director"] as const) for (const outcome of ["success", "memory-failure", "abort", "branch", "card", "world-error", "scribe-failure", "tavern-failure"] as const) test(`${mode}：五路并行启动且统一守卫与收尾：${outcome}`, { timeout: 10000 }, async () => {
 const worldStarted = deferred(), ecologyStarted = deferred(), memoryStarted = deferred(), scribeStarted = deferred(), tavernStarted = deferred();
 const releaseWorld = deferred(), releaseEcology = deferred(), releaseMemory = deferred(), releaseScribe = deferred(), releaseTavern = deferred();
  const ended: any[] = []; const activities: string[] = []; let memoryCalls = 0, tavernCalls = 0;
 const body = "她在书房整理账目。";
 const f = fixture(mode, mode === "direct" ? [{ text: body }] : directorScript(body), {
  world: true, ecology: true,
   sideGate: async (model, context) => {
   if (model === "literaryWorldFacts") { worldStarted.resolve(); await releaseWorld.promise; }
   if (model === "literaryWorld" && outcome === "world-error") throw new Error("synthetic world transport failure");
     if (model === "ecologyRuntime" && JSON.parse(promptMessageText(context.messages[0])).phase === "aftermath") { ecologyStarted.resolve(); await releaseEcology.promise; }
    if (model === "scribe") { scribeStarted.resolve(); await releaseScribe.promise; }
  },
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => ({ userInput: text, worldbookEntries: [] }),
   after: async () => { memoryCalls++; memoryStarted.resolve(); await releaseMemory.promise; if (outcome === "memory-failure") throw new Error("synthetic fill failure"); } },
   tavernPlugins: { enabled: () => true, before: async (packet: any) => packet.worldbookEntries ? { ...packet, retainedWorldbookIndices: packet.worldbookEntries.map((_: any, i: number) => i) } : packet,
    after: async () => { tavernCalls++; tavernStarted.resolve(); await releaseTavern.promise; if (outcome === "tavern-failure") throw new Error("synthetic variable failure"); } },
   events: { onTurnEnd: info => ended.push(info), onActivity: detail => activities.push(detail) },
 });
 if (outcome === "scribe-failure") f.setLedgerFail(true);
 const task = f.engine.performTurn("继续核对。");
 try {
  await bounded(Promise.all([worldStarted.promise, ecologyStarted.promise, memoryStarted.promise, scribeStarted.promise, tavernStarted.promise]), "all five background tasks started before any finishes");
  const oldLeaf = f.sm.getLeafId()!;
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-state").length, 0, "scene ledger must not block other domains");
  for (const model of ["literaryWorldFacts", "ecologyRuntime"]) {
    const payload = JSON.parse(promptMessageText(f.requests.find(request => request.model === model && (model !== "ecologyRuntime" || JSON.parse(promptMessageText(request.context.messages[0])).phase === "aftermath")).context.messages[0]));
   assert.equal(payload.final_rp_state, undefined); assert.equal(payload.current_scene_state, undefined);
   assert.ok(model === "literaryWorldFacts" ? payload.prior_rp_state_reference_only : payload.prior_scene_state_reference_only);
   assert.equal(model === "literaryWorldFacts" ? payload.frozen_narrative : payload.latest_turn.narrative, body);
  }
  assert.equal(ended.length, 0); assert.equal(tavernCalls, 1);
  if (outcome === "abort") f.engine.abort();
  if (outcome === "branch") f.sm.branch((f.sm.getBranch().find((e: any) => e.message?.role === "user") as any).id);
  if (outcome === "card") { const path = join(f.cwd, "liyuan.config.json"); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), card: "other.json" })); }
  releaseWorld.resolve(); releaseEcology.resolve(); releaseMemory.resolve(); releaseScribe.resolve();
  await new Promise(done => setImmediate(done));
   assert.equal(f.engine.isStreaming, true, "lock must not release while MVU/plugin work is alive");
   assert.match(activities.filter(detail => detail.startsWith("后台整理：")).at(-1)!, /仍在等待 酒馆插件／MVU$/);
  releaseTavern.resolve(); await task;
  if (outcome === "branch") f.sm.branch(oldLeaf);
  assert.equal(memoryCalls, 1, "parallel database work must not be repeated later in the turn");
  const receipts = f.sm.getBranch().filter((e: any) => e.customType === "rp-database-memory") as any[];
  const cancelled = outcome === "abort" || outcome === "branch" || outcome === "card";
  assert.equal(receipts.at(-1).data.status, cancelled || outcome === "memory-failure" ? "pending" : "complete");
  assert.equal(tavernCalls, 1, "parallel plugin work must not be repeated later in the turn");
  const branch = f.sm.getBranch() as any[];
  assert.equal(branch.filter(e => e.customType === "rp-tavern-plugin-settlement").at(-1).data.status, cancelled || outcome === "tavern-failure" ? "pending" : "complete");
  if (!cancelled) {
   const receipt = branch.filter(e => e.customType === "rp-turn-settlement").at(-1).data;
   assert.equal(receipt.ledgerDone, outcome !== "scribe-failure");
   assert.equal(receipt.worldDone, outcome !== "world-error");
    assert.equal(receipt.ecologyDone, true);
    const performance = branch.filter(e => e.customType === "rp-turn-performance").at(-1).data;
    assert.equal(performance.phases["settlement.world"].status, outcome === "world-error" ? "failed" : "success");
    assert.equal(performance.phases["settlement.tavern"].status, outcome === "tavern-failure" ? "failed" : "success");
   if (outcome === "scribe-failure") assert.equal(receipt.status, "pending");
  }
  assert.equal(replies(f.sm)[0].message.stopReason, "stop");
  assert.equal(f.engine.isStreaming, false);
 } finally { releaseWorld.resolve(); releaseEcology.resolve(); releaseMemory.resolve(); releaseScribe.resolve(); releaseTavern.resolve(); await task; f.cleanup(); }
});

test("场记失败后的下一拍只恢复缺失账本，不重跑已完成世界/生态/数据库/MVU", async () => {
 const ids: string[] = [], pluginIds: string[] = [];
 const f = fixture("direct", [{ text: "第一拍完整正文。" }, { text: "第二拍完整正文。" }], {
  world: true, ecology: true,
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12, before: async text => ({ userInput: text, worldbookEntries: [] }), after: async id => { ids.push(id!); } },
  tavernPlugins: { enabled: () => true, before: async (packet: any) => packet.worldbookEntries ? { ...packet, retainedWorldbookIndices: packet.worldbookEntries.map((_: any, i: number) => i) } : packet, after: async (id: string) => { pluginIds.push(id); } },
 });
 try {
  f.setLedgerFail(true); await f.engine.performTurn("第一条。");
  const first = replies(f.sm)[0].id;
  assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement").at(-1) as any).data.ledgerDone, false);
  const worlds = f.requests.filter(r => r.model === "literaryWorldFacts").length;
  const ecologies = f.requests.filter(r => r.model === "ecologyRuntime").length;
  f.setLedgerFail(false); await f.engine.performTurn("第二条。");
  assert.equal(f.requests.filter(r => r.model === "literaryWorldFacts").length, worlds + 1);
  assert.equal(f.requests.filter(r => r.model === "ecologyRuntime").length, ecologies + 1);
  assert.equal(ids.filter(id => id === first).length, 1); assert.equal(pluginIds.filter(id => id === first).length, 1);
  const recovered = f.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement" && e.data.narrativeEntryId === first).at(-1) as any;
  assert.equal(recovered.data.status, "complete"); assert.equal(recovered.data.ledgerDone, true);
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-presentation-delivery" && e.data.targetEntryId === first).length, 1);
 } finally { f.cleanup(); }
});

test("上一拍MVU恢复失败明确拒绝新输入，不发ACK不重复正文", async () => {
 let fail = true; const notices: string[] = [];
 const f = fixture("direct", [{ text: "上一拍完整正文。" }, { text: "修复后的下一拍。" }], {
  tavernPlugins: { enabled: () => true, before: async (packet: any) => packet.worldbookEntries ? { ...packet, retainedWorldbookIndices: packet.worldbookEntries.map((_: any, i: number) => i) } : packet,
   after: async () => { if (fail) throw Error("MVU candidate requests failed; no completion receipt: synthetic SDK error"); } },
  events: { onNotify: (_level, text) => notices.push(text) },
 });
 try {
  await f.engine.performTurn("第一条。"); let accepted = 0;
  await f.engine.performTurn("失败时不能受理。", { onAccepted: () => accepted++ });
  assert.equal(accepted, 0); assert.equal(replies(f.sm).length, 1);
  assert.ok(notices.some(text => /上一拍酒馆插件\/MVU整理仍未恢复，本条输入未受理/.test(text)));
  fail = false; await f.engine.performTurn("恢复后继续。"); assert.equal(replies(f.sm).length, 2);
 } finally { f.cleanup(); }
});

test("恢复场记期间取消不落迟到账本，已交付正文保留", async () => {
 let recovering = false; let f!: ReturnType<typeof fixture>;
 f = fixture("direct", [{ text: "完整保存正文。" }], { sideGate: async model => { if (recovering && model === "scribe") f.engine.abort(); } });
 try {
  f.setLedgerFail(true); await f.engine.performTurn("第一条。");
  const first = replies(f.sm)[0].id;
  f.setLedgerFail(false); recovering = true;
  await f.engine.performTurn("不能受理的第二条。");
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-state" && e.data._diagnosticSourceEntryId === first).length, 0);
  assert.equal(f.sm.getBranch().filter((e: any) => e.message?.role === "user").length, 1);
  assert.equal(replies(f.sm)[0].message.stopReason, "stop");
 } finally { f.cleanup(); }
});

test("世界/生态并发读取完整长正文，不用场记摘要替换或截断", async () => {
 const body = "合成正文。".repeat(5200) + "最终场景在码头。";
 const f = fixture("direct", [{ text: body }], { world: true, ecology: true });
 try {
  await f.engine.performTurn("继续。");
  const world = JSON.parse(promptMessageText(f.requests.find(r => r.model === "literaryWorldFacts").context.messages[0]));
  const ecology = JSON.parse(promptMessageText(f.requests.find(r => r.model === "ecologyRuntime").context.messages[0]));
  assert.equal(world.frozen_narrative, body); assert.equal(ecology.latest_turn.narrative, body);
  assert.equal(world.rp_state_basis, "pre-turn"); assert.equal(ecology.state_basis, "pre-turn");
 } finally { f.cleanup(); }
});

test("待执行资料写操作保留世界/生态→资料写入→数据库顺序", { timeout: 10000 }, async () => {
 const worldStarted = deferred(), releaseWorld = deferred(); let memoryCalls = 0;
 let f!: ReturnType<typeof fixture>;
 f = fixture("direct", [
  { calls: [{ name: "lorebook_write", args: { title: "合成规则", keys: ["合成"], content: "SYNTHETIC_UPDATED_LORE", constant: true } }] },
  { text: "她整理好了账目。" },
 ], {
  world: true,
  sideGate: async model => { if (model === "literaryWorldFacts") { worldStarted.resolve(); await releaseWorld.promise; } },
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => ({ userInput: text, worldbookEntries: [] }),
   after: async () => { memoryCalls++; assert.ok(loadStageMaterials(f.cwd).entries.some(entry => entry.content === "SYNTHETIC_UPDATED_LORE")); } },
 });
 const task = f.engine.performTurn("请把这条设定写入世界书，然后继续。");
 try {
  await bounded(worldStarted.promise, "world started before deferred owner write");
  assert.equal(memoryCalls, 0, "database must not read stale materials");
  assert.ok(!loadStageMaterials(f.cwd).entries.some(entry => entry.content === "SYNTHETIC_UPDATED_LORE"));
  releaseWorld.resolve(); await task;
  assert.equal(memoryCalls, 1);
  assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-database-memory").at(-1) as any).data.status, "complete");
 } finally { releaseWorld.resolve(); await task; f.cleanup(); }
});

test("正文交付后可提交下一条但只排队：数据库结算结束前不落新输入、不开始第二位作者", { timeout: 10000 }, async () => {
 const memoryStarted = deferred(), releaseMemory = deferred(), accepted: string[] = [], order: string[] = [];
 let memoryCalls = 0;
 const f = fixture("direct", [{ text: "第一拍正文。" }, { text: "第二拍正文。" }], {
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => { order.push("before:" + text); return { userInput: text, worldbookEntries: [] }; },
   after: async () => { if (++memoryCalls === 1) { memoryStarted.resolve(); await releaseMemory.promise; } order.push("memory-done"); } },
  events: { onAuthorReady: () => order.push("ready") },
 });
 const first = f.engine.performTurn("第一条。", { onAccepted: () => accepted.push("first") });
 let next: Promise<void> | undefined;
 try {
  await bounded(memoryStarted.promise, "database started");
  next = f.engine.performTurn("第二条。", { onAccepted: () => accepted.push("next") });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(accepted, ["first"]);
  assert.equal(f.sm.getBranch().filter((e: any) => e.message?.role === "user").length, 1);
  assert.equal(f.requests.filter(isPrimaryWriterRequest).length, 1);
  releaseMemory.resolve(); await Promise.all([first, next]);
  assert.deepEqual(accepted, ["first", "next"]);
  assert.equal(replies(f.sm).length, 2);
  assert.ok(order.indexOf("before:第二条。") > order.indexOf("memory-done"));
 } finally { releaseMemory.resolve(); await first; await next; f.cleanup(); }
});

test("交付后停止后台整理：正文不是半稿，数据库pending可在下一拍恢复，原稿不重复交付", { timeout: 10000 }, async () => {
 let f!: ReturnType<typeof fixture>, abortOnce = true;
 const readyIds: string[] = [], afterIds: string[] = [];
 f = fixture("direct", [{ text: '<content>已完成的正文。</content><附属格式>完整格式。</附属格式>' }, { text: "下一拍正文。" }], {
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => ({ userInput: text, worldbookEntries: [] }), after: async id => { afterIds.push(id!); } },
  events: { onAuthorReady: ({ entryId }) => { readyIds.push(entryId); if (abortOnce) { abortOnce = false; f.engine.abort(); } } },
 });
 try {
  await f.engine.performTurn("第一条。");
  const original = replies(f.sm)[0];
  assert.equal(original.message.stopReason, "stop");
  assert.equal(f.engine.isSettling, false); assert.equal(afterIds.length, 0);
  assert.equal(f.requests.some(r => r.model === "scribe"), false);
  assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-database-memory").at(-1) as any).data.status, "pending");
  await f.engine.performTurn("第二条。");
  assert.deepEqual(afterIds, readyIds);
  assert.equal(replies(f.sm).length, 2);
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-presentation-delivery" && e.data.targetEntryId === original.id).length, 1);
 } finally { f.cleanup(); }
});

test("作者半稿不发就绪事件；后台结算失败也不撤销已交付的完整正文", { timeout: 10000 }, async () => {
 const readyIds: string[] = [], ended: any[] = [];
 const half = fixture("direct", [{ text: "尚未写完的半稿", aborted: true }], { events: { onAuthorReady: info => readyIds.push(info.entryId) } });
 try { await half.engine.performTurn("继续。"); assert.equal(readyIds.length, 0); } finally { half.cleanup(); }
 const saved = fixture("direct", [{ text: '<content>完整正文。</content><附属格式>原格式。</附属格式>' }], {
  world: true, worldWithoutManifest: true,
  events: { onAuthorReady: info => readyIds.push(info.entryId), onTurnEnd: info => ended.push(info) },
 });
 try {
  await saved.engine.performTurn("继续。");
  assert.equal(readyIds.length, 1); assert.equal(ended[0].entryId, readyIds[0]); assert.match(ended[0].error, /world/);
  assert.equal(replies(saved.sm)[0].message.stopReason, "stop");
  assert.equal((saved.sm.getBranch().filter((e: any) => e.customType === "rp-turn-settlement").at(-1) as any).data.presentationDone, true);
  assert.equal(saved.sm.getBranch().filter((e: any) => e.customType === "rp-presentation-delivery").length, 1);
 } finally { saved.cleanup(); }
});


for (const change of ["abort", "branch"] as const) test(`后台数据库迟到成功不得补记complete：${change}`, { timeout: 10000 }, async () => {
 const started = deferred(), release = deferred(), ended: any[] = [];
 const f = fixture("direct", [{ text: "完整保存的合成正文。" }], {
  databasePluginMemory: { enabled: () => true, recentHistoryMessages: () => 12,
   before: async text => ({ userInput: text, worldbookEntries: [] }), after: async () => { started.resolve(); await release.promise; } },
  events: { onTurnEnd: info => ended.push(info) },
 });
 const task = f.engine.performTurn("合成输入。");
 try {
  await bounded(started.promise, "database started");
  const source = replies(f.sm)[0], oldLeaf = f.sm.getLeafId()!;
  if (change === "abort") f.engine.abort();
  else f.sm.branch((f.sm.getBranch().find((e: any) => e.message?.role === "user") as any).id);
  release.resolve(); await task;
  assert.equal(ended[0].aborted, true); assert.equal(ended[0].entryId, source.id);
  assert.equal(f.engine.isStreaming, false); assert.equal(f.engine.isSettling, false);
  if (change === "branch") f.sm.branch(oldLeaf);
  assert.equal(replies(f.sm)[0].message.stopReason, "stop");
  assert.equal(f.sm.getBranch().filter((e: any) => e.customType === "rp-database-memory" && e.data.status === "complete").length, 0);
  assert.equal((f.sm.getBranch().filter((e: any) => e.customType === "rp-database-memory").at(-1) as any).data.status, "pending");
 } finally { release.resolve(); await task; f.cleanup(); }
});

for (const mode of ["direct","director"] as const) {
 test(`${mode}: 原NPC候选仅在作者交付后统一生态入账，原稿字节不变`,async()=>{
  const marks:string[]=[];let f:ReturnType<typeof fixture>;let claims=0;
  const body="主角在屋内核对账目。\n<status>原作者附属格式</status>";
  const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_scope,guard)=>{guard();claims++;},generate:async input=>{
   marks.push("provider");assert.ok(marks.includes("author-ready"));
   const saved=replies(f.sm).find((e:any)=>e.id===input.scope.sourceEntryId);assert.equal(saved?.message.details.rpAuthorDraft,body);
   assert.ok(readFileSync(f.sm.getSessionFile()!,"utf8").includes(input.scope.sourceEntryId));
   await input.generate({messages:[{role:"user",content:"nativeGeneration"}],maxTokens:1000});
   return{version:"1.1.0",commit:"a".repeat(40),calls:1,errors:[],entries:[{name:"阿青",text:"阿青在书店整理书架。",info:"不知道：主角屋内的情况"}]};
  }};
  f=fixture(mode,mode==="direct"?[{text:body}]:directorScript(body),{ecology:true,npcParallel:provider,events:{onAuthorReady:()=>marks.push("author-ready")},npcReply:payload=>{
   const c=payload.npc_parallel.candidates[0];return{actors:[{id:c.actorId,name:c.name,location:"书店",activity:"整理书架"}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:"accept",quote:"在书店整理书架",reason:"场外生活与本拍时间一致",eventIds:[]}]};
  }});
  try{
   await f.engine.performTurn("继续核对。");const saved=replies(f.sm)[0];
   assert.equal(saved.message.details.rpAuthorDraft,body);assert.ok(!saved.message.details.rpNarrative.includes("阿青"));
   const receipt=f.sm.getBranch().find((e:any)=>e.customType==="rp-npc-parallel") as any;
   assert.equal(receipt.data.status,"accepted");assert.equal(receipt.data.sourceEntryId,saved.id);
   const ec=f.sm.getBranch().filter((e:any)=>e.customType==="rp-ecology-state").at(-1) as any;assert.equal(ec.data.actors[0].name,"阿青");
   assert.deepEqual(marks,["author-ready","provider"]);assert.equal(claims,2);
   const ordinaryAfter=f.requests.filter((r:any)=>r.model==="ecologyRuntime"&&JSON.stringify(r.context).includes('"phase":"aftermath"'));assert.equal(ordinaryAfter.length,0);
  }finally{f.cleanup();}
 });
}

for(const mode of ["direct","director"]as const) test(`${mode}: 拍后净化与领域并发，失败不撤回正文，不改事实及原稿`,async()=>{
 const body="他说话时眼底闪过一抹复杂。\n<options>继续交谈</options>";const markers:string[]=[];let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const ready=new Promise<void>(r=>started=r);let finished=false;
 const provider:VeridisRewriteProvider={enabled:()=>true,claimRequest:()=>{},run:async input=>{markers.push("rewrite-start");started();await gate;return{text:input.authorDraft.replace("眼底闪过一抹复杂","有些迟疑"),changed:true,calls:0,errors:[],version:"3.5",commit:"b".repeat(40)};}};
 const f=fixture(mode,mode==="direct"?[{text:body}]:directorScript(body),{veridisRewrite:provider,events:{onAuthorReady:()=>markers.push("author-ready")},databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>10,before:async text=>({userInput:text,worldbookEntries:[]}),after:async()=>{markers.push("memory-finished");}}});
 try{const task=f.engine.performTurn("继续交谈。").then(()=>{finished=true;});await ready;
  for(let i=0;i<100&&!markers.includes("memory-finished");i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(markers.includes("author-ready"));assert.ok(markers.includes("memory-finished"));assert.equal(finished,false);
  const saved=replies(f.sm)[0],beforeNarrative=saved.message.details.rpNarrative;assert.equal(saved.message.details.rpAuthorDraft,body);
  release();await task;assert.equal(saved.message.details.rpAuthorDraft,body);assert.equal(saved.message.details.rpNarrative,beforeNarrative);
  const receipt=f.sm.getBranch().find((e:any)=>e.customType==="rp-veridis-rewrite")as any;assert.equal(receipt.data.status,"complete");assert.equal(receipt.data.sourceEntryId,saved.id);assert.match(receipt.data.text,/有些迟疑/);
 }finally{release();f.cleanup();}
});
test('NPC pending恢复先统一入账再接受新输入，自有回执不伪装成切支且不重复原侧写生成',async()=>{
 let malformed=true,nativeCalls=0;const batches=new Map<string,any>();
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_scope,guard)=>guard(),generate:async input=>{
  if(batches.has(input.scope.sourceEntryId))return batches.get(input.scope.sourceEntryId);
  nativeCalls++;await input.generate({messages:[{role:'user',content:'nativeGeneration'}],maxTokens:800});
  const batch={version:'1.1.0',commit:'a'.repeat(40),calls:1,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}]};batches.set(input.scope.sourceEntryId,batch);return batch;
 }};
 const f=fixture('direct',[{text:'第一拍原文。'},{text:'第二拍原文。'}],{ecology:true,npcParallel:provider,npcReply:payload=>{
  if(malformed)return{actors:[]};const c=payload.npc_parallel.candidates[0];return{actors:[{id:c.actorId,name:c.name,location:'书店',activity:'整理书架'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',quote:'在书店整理书架',eventIds:[]}]};
 }});
 try{await f.engine.performTurn('第一条。');const first=replies(f.sm)[0];assert.equal(first.message.details.rpAuthorDraft,'第一拍原文。');assert.equal(nativeCalls,1);
  malformed=false;let ack=0;await f.engine.performTurn('第二条。',{onAccepted:()=>ack++});assert.equal(ack,1);assert.equal(replies(f.sm).length,2);assert.equal(nativeCalls,2,'第一拍恢复复用来源绑定候选，只有第二拍新增原生成');
  const receipts=f.sm.getBranch().filter((e:any)=>e.customType==='rp-npc-parallel'&&e.data.sourceEntryId===first.id)as any[];assert.equal(receipts.at(-1).data.status,'accepted');
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==='rp-turn-settlement'&&e.data.narrativeEntryId===first.id&&e.data.recovered===true));
 }finally{f.cleanup();}
});

for(const mode of ['direct','director'] as const) test(`${mode}: exhausted NPC allowance reports the actual recovery blocker without a model request`,async()=>{
 const reason='insufficient_quota: provider credits exhausted';
 let claims=0;
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_s,guard)=>{guard();claims++;throw Error(reason);},generate:async()=>({version:'synthetic',commit:'a'.repeat(40),calls:2,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}],cached:true})};
 const f=fixture(mode,[],{ecology:true,npcParallel:provider});
 try{
  f.sm.appendMessage({role:'user',content:[{type:'text',text:'继续。'}],timestamp:Date.now()}as never);
  const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'已保存正文。'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'已保存正文。',rpAuthorDraft:'已保存正文。',rpGenerationMode:mode}}as never);
  f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'pending',ledgerDone:true,worldDone:true,ecologyDone:false,presentationDone:true,degradedDomains:['ecology']});f.sm.flush();
  for(let i=0;i<2;i++){
   const result=await f.engine.retryPendingSettlement();assert.ok(result.error?.includes(reason));
   assert.equal(f.requests.length,0,'local quota rejection must not be described as a fresh upstream failure');
   const receipt=f.sm.getBranch().filter((e:any)=>e.customType==='rp-turn-settlement').at(-1)as any;
   assert.equal(receipt.data.status,'pending');assert.equal(receipt.data.ecologyDone,false);
  }
    assert.equal(claims,2);assert.equal(replies(f.sm).length,1);assert.equal(replies(f.sm)[0].message.details.rpAuthorDraft,'已保存正文。');
 }finally{f.cleanup();}
});

test('legacy NPC provenance-failure marked complete is recovered from pre-source ecology, never double-advanced',async()=>{
 let calls=0;const batch={version:'1.1.0',commit:'a'.repeat(40),calls:0,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}]};
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_s,g)=>{g();calls++;},generate:async()=>({...batch,cached:true})};
 const f=fixture('direct',[],{ecology:true,npcParallel:provider,npcReply:payload=>{const c=payload.npc_parallel.candidates[0];return{actors:[{id:c.actorId,name:c.name,location:'书店',activity:'本拍来源校验后整理书架'}],occurrences:[{id:'shelving',name:'场外整理书架',origin:'generated-offscreen',participants:[c.actorId],time:'当前清晨',location:'书店'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',quote:'在书店整理书架',eventIds:['shelving']}]};}});
 try{
  f.sm.appendCustomEntry('rp-ecology-state',{version:1,round:7,actors:[{id:'a',name:'阿青',location:'书店',activity:'拍前核对账目'}]});
  f.sm.appendMessage({role:'user',content:[{type:'text',text:'继续。'}],timestamp:Date.now()}as never);
  const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'已保存正文。'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'已保存正文。',rpAuthorDraft:'<content>已保存正文。</content>',rpGenerationMode:'direct'}}as never);
  f.sm.appendCustomEntry('rp-state',{characters:{},location:'书房',_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry('rp-npc-parallel',{version:1,sourceEntryId:id,status:'rejected',reason:'场外候选包含缺少真实来源的用户承诺，整批隔离；原生态保留',entries:[]});
  f.sm.appendCustomEntry('rp-ecology-state',{version:1,round:8,actors:[{id:'a',name:'阿青',location:'书店',activity:'拍前核对账目'}],_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'complete',ledgerDone:true,worldDone:true,ecologyDone:true,presentationDone:true,degradedDomains:[]});f.sm.flush();
  assert.equal((await f.engine.retryPendingSettlement()).error,undefined);assert.equal(calls,1);assert.deepEqual(f.requests.map(r=>r.model),['npcParallel']);
  const ec=f.sm.getBranch().filter((e:any)=>e.customType==='rp-ecology-state').at(-1)as any;assert.equal(ec.data.round,8,'repair same source, not another ecology round');assert.equal(ec.data.actors[0].activity,'本拍来源校验后整理书架');
   assert.equal(ec.data.occurrences[0].origin,'generated-offscreen');assert.equal(ec.data.occurrences[0].narrativeEvidence,undefined);
   assert.equal(replies(f.sm).length,1);assert.equal(replies(f.sm)[0].message.details.rpAuthorDraft,'<content>已保存正文。</content>');
  const before=f.requests.length;await f.engine.retryPendingSettlement();assert.equal(f.requests.length,before,'accepted source is not recovered twice');
 }finally{f.cleanup();}
});

test('manual settlement retries share persistent source allowance and stop immediately after recovery succeeds',async()=>{
  const attempts:unknown[]=[];let requests=0;
  const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_s,guard,id)=>{guard();assert.equal(id,undefined,'recovery must not reset the persistent source allowance');attempts.push(id);},generate:async()=>({version:'synthetic',commit:'a'.repeat(40),calls:0,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}],cached:true})};
 const f=fixture('direct',[],{ecology:true,npcParallel:provider,npcReply:payload=>{
   if(++requests<3)throw Error('HTTP 503 synthetic temporary gateway failure');
  const c=payload.npc_parallel.candidates[0];return{actors:[{id:c.actorId,name:c.name,activity:'整理书架'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',quote:'在书店整理书架',eventIds:[]}]};
 }});
 try{
  f.sm.appendMessage({role:'user',content:[{type:'text',text:'继续。'}],timestamp:Date.now()}as never);
  const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'原稿。'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'原稿。',rpAuthorDraft:'原稿。',rpGenerationMode:'direct'}}as never);
  f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'pending',ledgerDone:true,worldDone:true,ecologyDone:false,presentationDone:true,degradedDomains:['ecology']});f.sm.flush();
  assert.equal((await f.engine.retryPendingSettlement()).error,undefined);
   assert.equal(requests,3);assert.equal(new Set(attempts).size,1);assert.equal(attempts.length,3);assert.equal((settlementRetry.wait as any).mock.callCount(),2);
  await f.engine.retryPendingSettlement();assert.equal(requests,3,'completed ecology never replays');assert.equal(replies(f.sm).length,1);
 }finally{f.cleanup();}
});

test('legacy invalid snapshot remains pending after failed repair and cannot bypass recovery on retry',async()=>{
 let valid=false,claims=0;
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_s,g)=>{g();claims++;},generate:async()=>({version:'1.1.0',commit:'a'.repeat(40),calls:0,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}],cached:true})};
 const f=fixture('direct',[],{ecology:true,npcParallel:provider,npcReply:payload=>{const c=payload.npc_parallel.candidates[0];if(!valid)return{actors:[],npc_parallel_decisions:[{candidateId:c.id,actorId:'foreign-actor'}]};return{actors:[{id:c.actorId,name:c.name,activity:'来源已校验'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',quote:'在书店整理书架',eventIds:[]}]};}});
 try{
  f.sm.appendCustomEntry('rp-ecology-state',{round:2,actors:[{id:'a',name:'阿青',activity:'原状态'}]});f.sm.appendMessage({role:'user',content:[{type:'text',text:'继续。'}],timestamp:Date.now()}as never);
  const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'已存正文。'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'已存正文。',rpAuthorDraft:'已存正文。',rpGenerationMode:'direct'}}as never);
  f.sm.appendCustomEntry('rp-npc-parallel',{version:1,sourceEntryId:id,status:'rejected',reason:'场外候选包含缺少真实来源的用户承诺，整批隔离；原生态保留',entries:[]});f.sm.appendCustomEntry('rp-ecology-state',{round:3,actors:[{id:'a',name:'阿青',activity:'原状态'}],_diagnosticSourceEntryId:id});f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'complete',ledgerDone:true,worldDone:true,ecologyDone:true,presentationDone:true,degradedDomains:[]});f.sm.flush();
    assert.match((await f.engine.retryPendingSettlement()).error??'',/ecology/);const pending=f.sm.getBranch().filter((e:any)=>e.customType==='rp-turn-settlement').at(-1)as any;assert.equal(pending.data.status,'pending');assert.equal(pending.data.ecologyDone,false);assert.equal(claims,2);
    valid=true;assert.equal((await f.engine.retryPendingSettlement()).error,undefined);assert.equal(claims,3);const ec=f.sm.getBranch().filter((e:any)=>e.customType==='rp-ecology-state').at(-1)as any;assert.equal(ec.data.round,3);assert.equal(ec.data.actors[0].activity,'来源已校验');assert.equal(replies(f.sm).length,1);
 }finally{f.cleanup();}
});

for (const mode of ["direct", "director"] as const) test(`${mode}：首次世界画像在正文交付后建立，同拍世界结算且不阻塞数据库/MVU`, async () => {
 const body="她将合成账本收好。";let ready=false,release!:()=>void;
 const profileGate=new Promise<void>(r=>{release=r});const memoryStarted=deferred();
 const f=fixture(mode,mode==="direct"?[{text:body}]:directorScript(body),{world:true,worldWithoutManifest:true,worldProfile:"valid",
  events:{onAuthorReady:()=>{ready=true}},sideGate:async(model)=>{if(model==="worldProfile"){assert.equal(ready,true,"profile cannot delay the author");await profileGate;}},
  databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,before:async input=>({userInput:input,worldbookEntries:[]}),after:async()=>{memoryStarted.resolve()}}});
 try{
  const turn=f.engine.performTurn("继续合成场景。",{generationMode:mode});
  await bounded(memoryStarted.promise,"database starts without waiting for world-profile");assert.equal(ready,true);assert.equal(f.requests.some(r=>r.model==="worldProfile"),true);
  release();await turn;
  const branch=f.sm.getBranch() as any[],author=branch.find(e=>e.message?.details?.rpNarrative),user=branch.find(e=>e.id===author.parentId);
  assert.equal(user.message.role,"user");assert.equal(author.message.details.rpNarrative,body);
  const manifest=branch.find(e=>e.customType==="rp-world-manifest");assert.ok(branch.indexOf(manifest)>branch.indexOf(author));
  const receipt=branch.filter(e=>e.customType==="rp-turn-settlement").at(-1);assert.equal(receipt.data.worldDone,true);assert.equal(receipt.data.status,"complete");
  const materials=loadStageMaterials(f.cwd),profile=loadCardWorldProfile(f.cwd,"card.json",materials.card.name,"",materials.card)!;
  assert.equal(profile.analyzedTurns,1);assert.equal(profile.cardKey,manifest.data.cardKey);assert.equal(f.requests.filter(r=>r.model==="worldProfile").length,1);
 }finally{release?.();f.cleanup()}
});

test("世界画像失败留下pending；恢复只补画像和世界，不重写正文或重复场记/插件",async()=>{
 const f=fixture("direct",[{text:"她已保存合成账本。"}],{world:true,worldWithoutManifest:true});
 try{
  await f.engine.performTurn("继续。",{generationMode:"direct"});const authorCount=replies(f.sm).length,scribeCount=f.requests.filter(r=>r.model==="scribe").length;
  assert.equal((f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any).data.worldDone,false);
  f.setWorldProfileValid(true);const recovered=await f.engine.retryPendingSettlement();assert.equal(recovered.error,undefined);
  assert.equal(replies(f.sm).length,authorCount);assert.equal(f.requests.filter(r=>r.model==="scribe").length,scribeCount);
  const receipt=f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any;assert.equal(receipt.data.worldDone,true);assert.equal(receipt.data.status,"complete");
  const n=f.requests.length;await f.engine.retryPendingSettlement();assert.equal(f.requests.length,n,"completed recovery is not replayed");
 }finally{f.cleanup()}
});

for(const changed of ["cancel","card","branch"] as const)test(`首次画像${changed}失效不落盘、不采用世界候选`,async()=>{
 let f!:ReturnType<typeof fixture>;
 f=fixture("direct",[{text:"她已保存合成账本。"}],{world:true,worldWithoutManifest:true,worldProfile:"valid",sideGate:async(model)=>{if(model!=="worldProfile")return;
  if(changed==="cancel")f.engine.abort();
  if(changed==="card")writeFileSync(join(f.cwd,"card.json"),JSON.stringify({name:"云澜",description:"分析期间修改"}));
  if(changed==="branch")f.sm.branch((f.sm.getBranch().find((e:any)=>e.message?.role==="user") as any).id);
 }});
 try{await f.engine.performTurn("继续。",{generationMode:"direct"});const m=loadStageMaterials(f.cwd);assert.equal(loadCardWorldProfile(f.cwd,"card.json",m.card.name,"",m.card),null);assert.equal(f.requests.some(r=>r.model==="literaryWorldFacts"),false);}
 finally{f.cleanup()}
});

for (const mode of ["direct", "director"] as const) test(`${mode}：已有画像素材变更后空闲优化，下一拍采用新版本且不重复世界事实`,{timeout:10000},async()=>{
 const refreshed=deferred();let f!:ReturnType<typeof fixture>;
 const script=mode==="direct"?[{text:"她收好了合成账本。"},{text:"她走向合成书架。"}]:[...directorScript("她收好了合成账本。"),...directorScript("她走向合成书架。")];
 f=fixture(mode,script,{world:true,worldProfile:"valid",events:{onActivity:text=>{if(text.includes("角色卡世界画像：已保存"))refreshed.resolve()}}});
 try{
  const old=cachedWorldProfile(f);old.sourceFingerprint="old-material";old.revision=3;saveCardWorldProfile(f.cwd,"card.json",old,loadStageMaterials(f.cwd).card);
  await f.engine.performTurn("第一拍合成输入。",{generationMode:mode});const factsAfterFirst=f.requests.filter(r=>r.model==="literaryWorldFacts").length;
  await bounded(refreshed.promise,"idle profile optimization");assert.equal(f.requests.filter(r=>r.model==="worldProfile").length,1);
  assert.equal(f.requests.filter(r=>r.model==="literaryWorldFacts").length,factsAfterFirst,"profile optimization cannot replay world facts");
  await f.engine.performTurn("第二拍合成输入。",{generationMode:mode});
  const manifests=f.sm.getBranch().filter((e:any)=>e.customType==="rp-world-manifest") as any[];
  assert.equal(manifests.at(-1).data.profileRevision,4);assert.equal(manifests.at(-1).data.cardKey,old.cardKey);
  const current=loadStageMaterials(f.cwd);assert.equal(loadCardWorldProfile(f.cwd,"card.json",current.card.name,"",current.card)?.analyzedTurns,1);
 }finally{f.cleanup()}
});

test("首次画像在世界计算完成后素材才变：仅世界保持pending，不丢已完成生态/数据库收据",async()=>{
 let f!:ReturnType<typeof fixture>,memoryWrites=0;
 f=fixture("direct",[{text:"她将合成账本放回书架。"}],{world:true,worldWithoutManifest:true,worldProfile:"valid",ecology:true,
  databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,before:async input=>({userInput:input,worldbookEntries:[]}),after:async()=>{memoryWrites++}},
  sideGate:async model=>{if(model==="literaryWorldFacts")writeFileSync(join(f.cwd,"card.json"),JSON.stringify({name:"云澜",description:"画像之后才改变的资料"}));}});
 try{
  await f.engine.performTurn("继续合成场景。",{generationMode:"direct"});const receipt=f.sm.getBranch().filter((e:any)=>e.customType==="rp-turn-settlement").at(-1) as any;
  assert.equal(receipt.data.status,"pending");assert.equal(receipt.data.worldDone,false);assert.equal(receipt.data.ledgerDone,true);assert.equal(receipt.data.ecologyDone,true);assert.equal(memoryWrites,1);
  assert.ok(f.sm.getBranch().some((e:any)=>e.customType==="rp-database-memory"&&e.data.status==="complete"));
  const m=loadStageMaterials(f.cwd);assert.equal(loadCardWorldProfile(f.cwd,"card.json",m.card.name,"",m.card),null);
 }finally{f.cleanup()}
});

for (const mode of ["direct", "director"] as const) test(`plot direction is accepted with user, reaches existing author/director channels, stays across floors (${mode})`, async () => {
 let f: ReturnType<typeof fixture>; let resolutions = 0;
 const option = { id: "synthetic-option", cardId: "synthetic-card", cardHash: "synthetic-hash", title: "合成旧书清点机会", experience: "只借共同做事的结构", whyNow: "合成原因", draft: "合成草稿", prerequisites: [], setup: ["先提及清点工作"], development: ["共同清点时讨论分类"], boundaries: ["不预定关系变化"], entryCondition: "实际回应后进入" };
 const choice = { contextKey: "a".repeat(64), optionId: option.id };
 f = fixture(mode, mode === "direct" ? [{ text: "合成正文一。" }, { text: "合成正文二。" }] : [...directorScript("合成正文一。"), ...directorScript("合成正文二。")], {
  plotOptions: {
   resolve: actual => { resolutions++; assert.deepEqual(actual, choice); assert.equal(f.sm.getBranch().filter((e: any) => e.message?.role === "user").length, 0); return { version: 1, contextKey: choice.contextKey, option }; },
   reference: () => f.sm.getBranch().some((e: any) => e.message?.details?.rpPlotSelection) ? JSON.stringify({ kind: "user-selected-plot-direction-not-fact", title: option.title }) : undefined,
  },
 });
 try {
  await f.engine.performTurn("我自己修改的实际行动。", { clientMessageId: "plot-message", generationMode: mode, plotChoice: choice });
  const user = f.sm.getBranch().find((e: any) => e.message?.role === "user") as any;
  assert.equal(user.message.details.rpPlotSelection.option.id, option.id); assert.equal(user.message.content[0].text, "我自己修改的实际行动。");
  assert.ok(f.requests.filter(r => r.model === "writer").some(r => JSON.stringify(r.context).includes(option.title)));
  assert.ok(f.requests.filter(r => r.model === (mode === "direct" ? "literaryDirector" : "directorIdeas")).some(r => JSON.stringify(r.context).includes(option.title)));
  await f.engine.performTurn("继续眼前对话。", { generationMode: mode }); assert.equal(resolutions, 1);
  assert.ok(JSON.stringify(f.requests.at(-1)).includes(option.title) || f.requests.filter(r => r.model === "writer").slice(-2).some(r => JSON.stringify(r.context).includes(option.title)));
  assert.equal(f.requests.filter(r => r.model === "dailyPlot").length, 0, "story path must not call selection model");
 } finally { f.cleanup(); }
});
test("expired plot intent rejects before user persistence and ACK without disrupting normal RP", async () => {
 let accepted = false, rejectedReason = "";
 const f = fixture("direct", [{ text: "普通剧情仍可写。" }], { plotOptions: { resolve: () => { throw Error("expired plot choice"); }, reference: () => undefined } });
 try {
  await f.engine.performTurn("保留这份草稿。", { plotChoice: { contextKey: "b".repeat(64), optionId: "old" }, onAccepted: () => { accepted = true; }, onRejected: reason => { rejectedReason = reason; } });
  assert.equal(accepted, false); assert.match(rejectedReason, /expired plot choice/); assert.equal(f.sm.getBranch().filter((e: any) => e.message?.role === "user").length, 0);
  await f.engine.performTurn("普通输入。", { generationMode: "direct" });
  assert.ok(f.sm.getBranch().some((e: any) => e.message?.details?.rpNarrative === "普通剧情仍可写。"));
 } finally { f.cleanup(); }
});

for (const mode of ["direct", "director"] as const) test(`${mode}: local analysis deadline keeps its origin and does not impersonate user cancellation`, { timeout: 5000 }, async t => {
 const attempts = Array.from({ length: 4 }, () => deferred()); let calls = 0;
 const f = fixture(mode, mode === "direct" ? [{ text: "合成正文仍由同一作者交付。" }] : directorScript("合成导演定稿。"), { sideGate: async model => {
  if (model === (mode === "direct" ? "literaryDirector" : "literaryContinuity")) { attempts[calls++].resolve(); await new Promise(() => {}); }
 } });
 try {
  const path = join(f.cwd, "liyuan.config.json"), cfg = JSON.parse(readFileSync(path, "utf8")); cfg.analysisTimeoutMinutes = 1; writeFileSync(path, JSON.stringify(cfg));
  t.mock.timers.enable({ apis: ["setTimeout"] }); const turn = f.engine.performTurn("合成超时边界。", { generationMode: mode });
   // Each bounded side-stage retry owns a fresh analysis deadline.
   for (const attempt of attempts) { await attempt.promise; t.mock.timers.tick(60_001); }
   await turn;
   assert.equal(calls, 4);
  const diagnostics = f.sm.getBranch().filter((e: any) => e.customType === "rp-model-diagnostics").flatMap((e: any) => e.data.calls);
  const failed = diagnostics.find((c: any) => c.step === (mode === "direct" ? "literaryDirector" : "literaryContinuity"));
  assert.equal(failed.kind, "timeout"); assert.equal(failed.origin, "local-timeout"); assert.equal(failed.timeoutScope, "analysis"); assert.equal(failed.status, "failed"); assert.doesNotMatch(failed.reason, /已取消/);
  const records = new RequestJournal(f.cwd).list({ sessionId: f.sm.getSessionId(), card: "card.json" }, new Set(f.sm.getBranch().map((e: any) => e.id)));
  const receipt = records.find(r => r.model === failed.model); assert.equal(receipt?.status, "failed"); assert.equal(receipt?.failure?.origin, "local-timeout"); assert.equal(receipt?.usageSource, "missing");
 } finally { t.mock.timers.reset(); f.cleanup(); }
});

for (const mode of ['direct','director'] as const) test(`${mode}: new NPC ids bind without a paid whole-report retry and background progress retains the actual substage`,async()=>{
 const activity:string[]=[];let claims=0;const body='合成主角在屋内核对书页。\n<status>原作者格式</status>';
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_scope,guard)=>{guard();claims++;},generate:async input=>{
  await input.generate({messages:[{role:'user',content:'nativeGeneration'}],maxTokens:1000});
  return{version:'1.1.0',commit:'a'.repeat(40),calls:1,errors:[],entries:[{name:'阿青',text:'阿青在书店整理书架。'}]};
 }};
 const f=fixture(mode,mode==='direct'?[{text:body}]:directorScript(body),{ecology:true,npcParallel:provider,events:{onActivity:detail=>activity.push(detail)},npcReply:payload=>{
  const c=payload.npc_parallel.candidates[0];return{actors:[{id:'model-local-librarian',name:c.name,location:'书店',activity:'整理书架'}],npc_parallel_decisions:[{candidateId:c.id,actorId:'model-local-librarian',verdict:'accept',quote:'在书店整理书架',eventIds:[]}]};
 }});
 try{
  await f.engine.performTurn('继续核对书页。');const saved=replies(f.sm)[0];
  assert.equal(saved.message.details.rpAuthorDraft,body);assert.equal(claims,2);
  assert.equal(f.requests.filter(r=>r.model==='npcParallel').length,2);
  const receipt=f.sm.getBranch().find((r:any)=>r.customType==='rp-npc-parallel') as any;
  assert.equal(receipt.data.status,'accepted');assert.equal(receipt.data.sourceEntryId,saved.id);
  const ec=f.sm.getBranch().filter((r:any)=>r.customType==='rp-ecology-state').at(-1) as any;
  assert.equal(ec.data.actors[0].id,receipt.data.entries[0].actorId);
  assert.notEqual(ec.data.actors[0].id,'model-local-librarian');
  assert.ok(activity.some(s=>s.startsWith('后台整理：')&&s.includes('侧写请求 1')));
  assert.ok(activity.some(s=>s.startsWith('后台整理：')&&s.includes('鲜活世界／NPC（生态接入）')));
  assert.ok(!activity.some(s=>s.startsWith('后台整理：')&&s.includes('校验修复')));
  assert.equal(f.engine.isSettling,false);
 }finally{f.cleanup();}
});

for (const mode of ["direct", "director"] as const) test(`${mode}: policy-blocked ledger stays pending without auto-retry; reviewed ledger resumes without rewriting`, async () => {
 const {ledgerStatusFromBranch}=await import("../src/stage/ledger-status.ts");
 const refusal="[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT";
 const scripts=mode==="direct"?[{text:"合成角色走进图书室。"},{text:"合成角色在图书室登记借书。"}]:[...directorScript("合成角色走进图书室。"),...directorScript("合成角色在图书室登记借书。")];
 const f=fixture(mode,scripts,{scribeReply:()=>refusal});
 try {
  // Even a configured recovery model must never become a policy-refusal workaround.
  const config=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));config.analysisRecoveryModel={provider:"alternate",id:"recovery"};writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(config));
  await f.engine.performTurn("去图书室。");const original=replies(f.sm)[0] as any;assert.ok(original);const id=original.id;
  const status=ledgerStatusFromBranch(f.sm.getBranch() as any);assert.equal(status.status,"blocked");
  assert.equal(f.requests.filter(x=>x.model==="scribe").length,1);assert.equal(f.requests.filter(x=>x.model==="recovery").length,0);
  const journal=new RequestJournal(f.cwd).list({sessionId:f.sm.getSessionId(),card:"card.json"},new Set([id]));const call=journal.find(x=>x.phase==="settlement.scribe");assert.equal(call?.status,"failed");assert.equal(call?.failure?.kind,"content-filter");
  const count=f.requests.length;let accepted=0;await f.engine.performTurn("这条不应受理。",{onAccepted:()=>accepted++});assert.equal(accepted,0);assert.equal(f.requests.length,count);assert.equal(replies(f.sm).length,1);
  const before=f.sm.getLeafId();assert.throws(()=>f.engine.confirmLedger({sessionId:"wrong",card:"card.json",sourceEntryId:id,revision:status.revision!},{}),/会话/);assert.equal(f.sm.getLeafId(),before);
  f.engine.confirmLedger({sessionId:f.sm.getSessionId(),card:"card.json",sourceEntryId:id,revision:status.revision!},{location:"合成图书室"});assert.equal(f.requests.length,count);assert.equal(ledgerStatusFromBranch(f.sm.getBranch() as any).status,"current");
  await f.engine.retryPendingSettlement();assert.equal(f.requests.length,count,"confirmed ledger does not charge or replay other completed domains");assert.equal(replies(f.sm).length,1);assert.equal((replies(f.sm)[0] as any).message.details.rpNarrative,original.message.details.rpNarrative);
 }finally{f.cleanup();}
});

test("explicit settlement retry sends once for safety refusal while automatic recovery remains blocked",async()=>{
 const {ledgerStatusFromBranch}=await import("../src/stage/ledger-status.ts");
 const f=fixture("direct",[{text:"合成角色走进图书室。"}],{scribeReply:()=>"[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT"});
   try{await f.engine.performTurn("去图书室。");const before=f.requests.length;const result=await f.engine.retryPendingSettlement();assert.match(result.error??"",/账本恢复尚未完成/);assert.equal(f.requests.length,before+1);assert.equal(f.requests.at(-1)?.model,"scribe");assert.equal(ledgerStatusFromBranch(f.sm.getBranch() as any).status,"blocked");assert.equal(replies(f.sm).length,1);}finally{f.cleanup();}
});

test("manual ledger edit writes the branch immediately without a legacy callback or stale cache base",async()=>{
 const {ledgerStatusFromBranch}=await import("../src/stage/ledger-status.ts");
 const f=fixture("direct",[{text:"合成人物进入图书室。"}],{scribeReply:()=>"[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT"});
 try{
  f.engine.editLedger({time:"合成清晨",location:"合成车站",flags:{keep:"保留"}});const initial=f.sm.getLeafId();await f.engine.performTurn("去图书室。");const before=f.requests.length,status=ledgerStatusFromBranch(f.sm.getBranch() as any);
  f.engine.editLedger({location:"合成图书室"},{time:"错误缓存",location:"旧分支",characters:{},flags:{},inventory:[],plot_threads:[]});const latest=f.sm.getBranch().filter((x:any)=>x.customType==="rp-state").at(-1)as any;assert.equal(latest.data.location,"合成图书室");assert.equal(latest.data.time,"合成清晨");assert.equal(latest.data.flags.keep,"保留");assert.equal(ledgerStatusFromBranch(f.sm.getBranch() as any).status,"blocked");assert.notEqual(ledgerStatusFromBranch(f.sm.getBranch() as any).revision,status.revision);assert.equal(f.requests.length,before);
  f.sm.branch(initial!);assert.equal((f.sm.getBranch().filter((x:any)=>x.customType==="rp-state").at(-1)as any).data.location,"合成车站");
 }finally{f.cleanup();}
});


function seedLedgerRetry(f: ReturnType<typeof fixture>, extra: Record<string,unknown> = {}, narrative = "合成人物走进图书室，在借阅台登记旧书。") {
 const stateId=f.sm.appendCustomEntry("rp-state",{time:"合成清晨",location:"合成车站",characters:{},inventory:[],flags:{preserve:"原值"},plot_threads:[],compatUnknown:{preserve:true}});
 f.sm.appendMessage({role:"user",content:[{type:"text",text:"我要登记借书。"}]} as never);
 const sourceEntryId=f.sm.appendMessage({role:"assistant",content:[{type:"text",text:narrative}],stopReason:"stop",details:{rpGenerationMode:"direct",rpNarrative:narrative,rpAuthorDraft:narrative+"\n<options>DISPLAY_ONLY_NOT_A_FACT</options>"}} as never);
 f.sm.appendCustomEntry("rp-presentation-delivery",{targetEntryId:sourceEntryId,version:1,display:narrative+"\n<options>DISPLAY_ONLY_NOT_A_FACT</options>"});
 f.sm.appendCustomEntry("rp-turn-settlement",{version:1,narrativeEntryId:sourceEntryId,status:"pending",ledgerDone:false,worldDone:false,ecologyDone:false,presentationDone:true,degradedDomains:["ledger","world","ecology","memory","tavern-plugins"],compatUnknown:"keep",...extra});f.sm.flush();
 return {sourceEntryId,stateId};
}
async function ledgerRetryExpected(f: ReturnType<typeof fixture>) { const {ledgerStatusFromBranch}=await import("../src/stage/ledger-status.ts");const view=ledgerStatusFromBranch(f.sm.getBranch() as any);return{sessionId:f.sm.getSessionId(),card:"card.json",sourceEntryId:view.sourceEntryId!,revision:view.revision!}; }

for(const mode of ["direct","director"] as const)test(`${mode}: ledger-only retry requests only configured scribe, leaves other pending domains and story untouched`,async()=>{
 const forbidden=async()=>{throw Error("Other settlement route must never run")};const ended:any[]=[];
 const f=fixture(mode,[],{scribeReply:()=>JSON.stringify({patch:{location:"合成图书室"}}),world:true,ecology:true,events:{onTurnEnd:r=>ended.push(r)},databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>10,before:forbidden,after:forbidden},tavernPlugins:{enabled:()=>true,before:forbidden,after:forbidden}});
 try{
  const {sourceEntryId}=seedLedgerRetry(f),before=replies(f.sm).map((x:any)=>JSON.stringify(x));const cfg=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));cfg.analysisRecoveryModel={provider:"alternate",id:"recovery"};writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(cfg));
  const result=await f.engine.retryLedger(await ledgerRetryExpected(f));assert.equal(result.error,undefined);assert.equal(result.ledgerUpdated,true);assert.equal(result.noChanges,false);assert.deepEqual(f.requests.map(x=>x.model),["scribe"]);assert.deepEqual(replies(f.sm).map((x:any)=>JSON.stringify(x)),before);assert.equal(ended.at(-1).entryId,undefined);
  const body=JSON.stringify(f.requests[0].context);assert.match(body,/合成人物走进图书室/);assert.doesNotMatch(body,/DISPLAY_ONLY_NOT_A_FACT/);
  const rows=f.sm.getBranch() as any[],state=rows.filter(x=>x.customType==="rp-state").at(-1).data,receipt=rows.filter(x=>x.customType==="rp-turn-settlement").at(-1).data;assert.equal(state.location,"合成图书室");assert.equal(state._diagnosticSourceEntryId,sourceEntryId);assert.equal(state.flags.preserve,"原值");assert.deepEqual(state.compatUnknown,{preserve:true});assert.equal(receipt.ledgerDone,true);assert.equal(receipt.worldDone,false);assert.equal(receipt.ecologyDone,false);assert.equal(receipt.presentationDone,true);assert.equal(receipt.compatUnknown,"keep");assert.equal(receipt.status,"pending");assert.deepEqual(receipt.degradedDomains,["world","ecology","memory","tavern-plugins"]);assert.equal(rows.some(x=>["rp-world-state","rp-ecology-state","rp-database-memory","rp-tavern-plugin-settlement"].includes(x.customType)),false);
  const journal=new RequestJournal(f.cwd).list({sessionId:f.sm.getSessionId(),card:"card.json"},new Set([sourceEntryId]));assert.equal(journal.length,1);assert.equal(journal[0].phase,"settlement.scribe");assert.equal(journal[0].sourceEntryId,sourceEntryId);
  await assert.rejects(f.engine.retryLedger(await ledgerRetryExpected(f)),/已完成|待补写/);assert.equal(f.requests.length,1);
 }finally{f.cleanup();}
});

test("ledger-only retry: valid empty patch settles only ledger without fabricating a snapshot",async()=>{
 const f=fixture("direct",[],{scribeReply:()=>'{"patch":{}}'});try{seedLedgerRetry(f);const count=(f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-state").length,result=await f.engine.retryLedger(await ledgerRetryExpected(f));assert.equal(result.error,undefined);assert.equal(result.ledgerUpdated,false);assert.equal(result.noChanges,true);assert.equal((f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-state").length,count);assert.equal(f.requests.length,1);const receipt=(f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-turn-settlement").at(-1).data;assert.equal(receipt.ledgerDone,true);assert.equal(receipt.worldDone,false);}finally{f.cleanup();}
});

for(const response of [
 {error:"HTTP 524 transport timed out"},
 {text:"[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT"},
 {text:"malformed synthetic output"}, {text:'{"patch":null}'}, {text:'{"patch":[]}'},
 {text:'{"patch":{"unknownField":"invalid"}}'}, {text:'{"patch":{"location":"not committed"}}',stopReason:"length"}
])test(`ledger-only failure ${JSON.stringify(response)} never changes state or borrows recovery`,async()=>{
 const f=fixture("direct",[],{scribeResponse:()=>response});try{seedLedgerRetry(f);const cfg=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));cfg.analysisRecoveryModel={provider:"alternate",id:"recovery"};writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(cfg));const before=(f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-state").map(x=>JSON.stringify(x));const result=await f.engine.retryLedger(await ledgerRetryExpected(f));assert.ok(result.error);assert.deepEqual(f.requests.map(x=>x.model),["scribe"]);assert.deepEqual((f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-state").map(x=>JSON.stringify(x)),before);const receipt=(f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-turn-settlement").at(-1).data;assert.equal(receipt.ledgerDone,false);assert.equal(receipt.worldDone,false);assert.equal(receipt.status,"pending");const diagnostic=(f.sm.getBranch() as any[]).filter(x=>x.customType==="rp-turn-diagnostic").at(-1).data;assert.equal(diagnostic.kind,"failed");assert.ok(diagnostic.error);if("text" in response&&response.text?.startsWith("[Proxy"))assert.equal(diagnostic.failureKind,"content-filter");}finally{f.cleanup();}
});

test("ledger-only preflight rejects stale scope and missing independent model without a provider request",async()=>{
 const f=fixture("direct",[]);try{seedLedgerRetry(f);const expected=await ledgerRetryExpected(f),leaf=f.sm.getLeafId();for(const wrong of [{...expected,sessionId:"other"},{...expected,card:"other.json"},{...expected,sourceEntryId:"other"},{...expected,revision:"old"}]){await assert.rejects(f.engine.retryLedger(wrong),/已变化/);assert.equal(f.sm.getLeafId(),leaf);}assert.equal(f.requests.length,0);const cfg=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));delete cfg.stepModels.scribe;writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(cfg));const result=await f.engine.retryLedger(expected);assert.match(result.error??"",/独立场记/);assert.equal(f.requests.length,0);}finally{f.cleanup();}
});

for(const change of ["abort","branch","ledger","model","material","card"]as const)test(`ledger-only late ${change} cannot overwrite source and cannot start a second request`,async()=>{
 let started!:()=>void,release!:()=>void;const waiting=new Promise<void>(ok=>started=ok),gate=new Promise<void>(ok=>release=ok);const f=fixture("direct",[],{sideGate:async id=>{if(id==="scribe"){started();await gate}}});
 try{const {stateId}=seedLedgerRetry(f),expected=await ledgerRetryExpected(f),job=f.engine.retryLedger(expected);await waiting;await assert.rejects(f.engine.retryLedger(expected),/正在处理/);assert.throws(()=>f.engine.editLedger({location:"forbidden"}),/正在处理/);
  if(change==="abort")f.engine.abort();if(change==="branch")f.sm.branch(stateId!);if(change==="ledger")f.sm.appendCustomEntry("rp-state",{location:"用户新改动"});if(change==="model"){const cfg=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));cfg.stepModels.scribe={provider:"other",id:"changed"};writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(cfg));}
  if(change==="material"){const card=JSON.parse(readFileSync(join(f.cwd,"card.json"),"utf8"));card.data.description="合成卡材料在等待中已变更";writeFileSync(join(f.cwd,"card.json"),JSON.stringify(card));}
  if(change==="card"){const cfg=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));cfg.card="missing-new-card.json";writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify(cfg));}
  const leaf=f.sm.getLeafId(),beforeStates=(f.sm.getBranch() as any[]).filter(e=>["rp-state","rp-turn-settlement"].includes(e.customType)).map(e=>JSON.stringify(e));release();const result=await job;assert.ok(result.error);if(change!=="abort")assert.equal(f.sm.getLeafId(),leaf);else{assert.equal(result.aborted,true);assert.deepEqual((f.sm.getBranch() as any[]).filter(e=>["rp-state","rp-turn-settlement"].includes(e.customType)).map(e=>JSON.stringify(e)),beforeStates);}assert.deepEqual(f.requests.map(x=>x.model),["scribe"]);assert.equal(f.engine.isStreaming,false);
 }finally{release?.();f.cleanup();}
});

test("ledger-only source guard checks again after auth; no stale request is sent",async()=>{
 let started!:()=>void,release!:()=>void;const waiting=new Promise<void>(ok=>started=ok),gate=new Promise<void>(ok=>release=ok);const f=fixture("direct",[],{authGate:async()=>{started();await gate}});
 try{const {stateId}=seedLedgerRetry(f),job=f.engine.retryLedger(await ledgerRetryExpected(f));await waiting;f.sm.branch(stateId!);const leaf=f.sm.getLeafId();release();assert.ok((await job).error);assert.equal(f.requests.length,0);assert.equal(f.sm.getLeafId(),leaf);}finally{release?.();f.cleanup();}
});

test("ledger-only source carries the complete canonical narrative above legacy clipping budget",async()=>{
 const f=fixture("direct",[],{scribeReply:()=>'{"patch":{}}'});try{const narrative="FULL_CANONICAL_START"+"合成记录。".repeat(8000)+"FULL_CANONICAL_END";seedLedgerRetry(f,{},narrative);await f.engine.retryLedger(await ledgerRetryExpected(f));assert.equal(f.requests.length,1);const input=f.requests[0].context.messages[0].content[0].text;assert.ok(input.includes(narrative));assert.match(input,/FULL_CANONICAL_START/);assert.match(input,/FULL_CANONICAL_END/);}finally{f.cleanup();}
});

test("ledger-only cancel releases the busy lock even if authentication ignores cancellation",async()=>{
 let started!:()=>void,release!:()=>void;const waiting=new Promise<void>(ok=>started=ok),gate=new Promise<void>(ok=>release=ok);const f=fixture("direct",[],{authGate:async()=>{started();await gate}});
 try{seedLedgerRetry(f);const job=f.engine.retryLedger(await ledgerRetryExpected(f));await waiting;f.engine.abort();const result=await Promise.race([job,new Promise<never>((_,bad)=>setTimeout(()=>bad(Error("cancellation waited for auth")),1000))]);assert.equal(result.aborted,true);assert.equal(f.engine.isStreaming,false);assert.equal(f.requests.length,0);release();await new Promise(ok=>setTimeout(ok,10));assert.equal(f.requests.length,0);}finally{release?.();f.cleanup();}
});


for (const mode of ["direct", "director"] as const) test(`${mode}: 数据库召回携带Stitches与本拍资料，合并成功不再单独请求文学导演`, async () => {
 let prep=0, after=0;
 const f=fixture(mode,mode==='director'?directorScript('合并后的同一作者正文。'):[{text:'合并后的同一作者正文。'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,
  before:async (text,signal,director)=>{prep++;assert.ok(!signal?.aborted);assert.match(director!.systemPrompt,/Stitches/);assert.match(director!.systemPrompt,/liyuan_literary_direction/);const data=JSON.parse(director!.userText);assert.equal(data.latest_user_input,text);assert.equal(data.character_card_reference.name,'云澜');return {...pluginBeforeResult(text),literaryDirectorHandled:true,literaryDirection:normalDirector};},after:async()=>{after++;}}});
 try{await f.engine.performTurn('只继续核对账目。');assert.equal(prep,1);assert.equal(after,1);assert.equal(f.requests.filter(r=>r.model==='literaryDirector').length,0);assert.equal(replies(f.sm).length,1);const writer=f.requests.find(r=>r.model==='writer');assert.match(JSON.stringify(writer.context),/AM0001/);assert.match(JSON.stringify(writer.context),/一起核对账目/);if(mode==='director')assert.equal(f.requests.filter(r=>!['writer','scribe'].includes(r.model)).length,7);}
 finally{f.cleanup();}
});
for (const candidate of [undefined,'broken','{}','{"unknown":"not director"}','{"scenePressure":42}']) test(`数据库已启用时合并候选缺失或无效也不再独立调用文学导演：${candidate}`,async()=>{
 const f=fixture('direct',[{text:'无额外导演调用的作者正文。'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,before:async text=>({...pluginBeforeResult(text),literaryDirectorHandled:true,literaryDirection:candidate}),after:async()=>{}}});
 try{await f.engine.performTurn('继续。');assert.equal(f.requests.filter(r=>r.model==='literaryDirector').length,0);assert.equal(replies(f.sm)[0].message.details.rpPrep.workflowStatus.director,'degraded');assert.equal(replies(f.sm).length,1);}finally{f.cleanup();}
});
test('合并导演明确无建议时不发起额外模型调用',async()=>{
 const f=fixture('direct',[{text:'沿现有场景自然继续。'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,before:async text=>({...pluginBeforeResult(text),literaryDirectorHandled:true,literaryDirection:'{"scenePressure":"","candidateBeats":[]}'}),after:async()=>{}}});
 try{await f.engine.performTurn('继续。');assert.equal(f.requests.filter(r=>r.model==='literaryDirector').length,0);assert.equal(replies(f.sm).length,1);assert.equal(replies(f.sm)[0].message.details.rpPrep.workflowStatus.director,'success');}finally{f.cleanup();}
});

for(const mode of ['direct','director'] as const)test(`${mode}: native database observations reach both phases without counting independent director calls`,async()=>{
 const observed:string[]=[];
 const f=fixture(mode,mode==='director'?directorScript('Synthetic canonical story.'):[{text:'Synthetic canonical story.'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,
  before:async(text,_signal,_director,observation)=>{assert.ok(observation);observed.push(observation.phase);const call=observation.collector.beginCall(observation.phase);call.usage({input:3,output:2});call.end('success');return{...pluginBeforeResult(text),literaryDirectorHandled:true,literaryDirection:normalDirector};},
  after:async(_id,_signal,observation)=>{assert.ok(observation);observed.push(observation.phase);const call=observation.collector.beginCall(observation.phase);call.end('success');},
 }});
 try{
  await f.engine.performTurn('Synthetic next input.');
  assert.deepEqual(observed,['prep.database','settlement.memory']);
  const data=(f.sm.getBranch() as any[]).find(e=>e.customType==='rp-turn-performance')!.data;
  assert.equal(data.phases['prep.database'].calls,1);assert.equal(data.phases['prep.database'].inputTokens,3);
  assert.equal(data.phases['settlement.memory'].calls,1);assert.equal(data.phases['settlement.memory'].inputTokens,undefined);
  assert.equal(data.phases['prep.director'].calls,0);assert.equal(data.phases['prep.director'].reason,'merged-database-recall');
  assert.equal(data.phases['prep.memoryRecall'].reason,'upstream-plugin-managed');
  assert.equal(f.requests.filter(r=>r.model==='literaryDirector').length,0);
 }finally{f.cleanup();}
});

for(const status of [524,401,402,404])test(`database ${status}: sanitized pending classification controls bounded settlement recovery`,async()=>{
 let after=0;
 const f=fixture('direct',[{text:'Synthetic saved story.'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,
  before:async text=>({...pluginBeforeResult(text),literaryDirectorHandled:true,literaryDirection:normalDirector}),
  after:async()=>{after++;if(after===1||status!==524)throw Error(`原数据库拍后整理失败 HTTP ${status}: ${status===524?'origin web server did not return complete response within 120s Proxy Read Timeout':'permanent upstream rejection'}`);},
 }});
 try{
  await f.engine.performTurn('Synthetic next input.');
  assert.equal(after,status===524?2:1,'only transient failure should run task recovery');
  const receipts=(f.sm.getBranch() as any[]).filter(e=>e.customType==='rp-database-memory').map(e=>e.data);
  const failed=receipts.find(e=>e.failure);
  assert.equal(failed.status,'pending');assert.equal(failed.failure.statusCode,status);assert.equal(failed.failure.origin,'provider');
  assert.equal(failed.failure.kind,status===524?'timeout':status===404?'model':'auth');
  assert.equal(receipts.at(-1).status,status===524?'complete':'pending');
  assert.equal(replies(f.sm).length,1);assert.equal(f.requests.filter(r=>r.model==='literaryDirector').length,0);
  assert.equal(f.requests.filter(r=>r.model==='scribe').length,1,'completed ledger must not be repeated');
 }finally{f.cleanup();}
});

test('persistent database 524 stops after the existing three recovery attempts and preserves failed receipts',async()=>{
 let after=0;
 const f=fixture('direct',[{text:'Synthetic saved story.'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,
  before:async text=>pluginBeforeResult(text),after:async()=>{after++;throw Error('HTTP 524 Proxy Read Timeout');},
 }});
 try{
  await f.engine.performTurn('Synthetic next input.');assert.equal(after,4);
  const receipts=(f.sm.getBranch() as any[]).filter(e=>e.customType==='rp-database-memory').map(e=>e.data);
  assert.equal(receipts.filter(e=>e.failure).length,4);
  assert.equal(receipts.at(-1).status,'pending');assert.equal(receipts.at(-1).failure.statusCode,524);
  assert.equal(replies(f.sm).length,1);assert.equal(f.requests.filter(r=>r.model==='scribe').length,1);
 }finally{f.cleanup();}
});

test('each manual settlement invocation has its own initial attempt plus three retries without a cumulative ceiling',async()=>{
 let after=0;
 const f=fixture('direct',[{text:'Synthetic saved story.'}],{databasePluginMemory:{enabled:()=>true,recentHistoryMessages:()=>12,
  before:async text=>pluginBeforeResult(text),after:async()=>{after++;throw Error('HTTP 524 Proxy Read Timeout');},
 }});
 try{
  await f.engine.performTurn('Synthetic next input.');assert.equal(after,4);
  const draft=JSON.stringify(replies(f.sm));
  for(const expected of [8,12,16]){
   const result=await f.engine.retryPendingSettlement();
   assert.match(result.error??'',/524/);assert.equal(after,expected);
   assert.equal(JSON.stringify(replies(f.sm)),draft);
  }
 }finally{f.cleanup();}
});

test('explicit saved NPC admission stays source-bound, adopts once, and preserves author and completed domains',async()=>{
 const selected=['c'.repeat(64)];let claims=0,runs=0;
 const provider:NpcParallelProvider={enabled:()=>true,claimRequest:(_scope,guard)=>{guard();claims++},generate:async input=>{runs++;assert.equal(input.explicitRetry,true);assert.deepEqual(input.admissionCandidateHashes,selected);return{version:'fixture',commit:'a'.repeat(40),calls:2,errors:[],admissionOnly:true,entries:[{name:'阿青',text:'阿青在书店整理书架。'}]}}};
 const f=fixture('direct',[],{ecology:true,npcParallel:provider,npcReply:payload=>{const c=payload.npc_parallel.candidates[0];return{actors:[{id:c.actorId,name:c.name,location:'书店',activity:'整理书架'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',quote:'在书店整理书架',eventIds:[]}]}}});
 try{
  f.sm.appendCustomEntry('rp-ecology-state',{version:1,round:2,actors:[{id:'a',name:'阿青',location:'书店',activity:'核对账目'}]});
  f.sm.appendMessage({role:'user',content:[{type:'text',text:'继续。'}],timestamp:Date.now()}as never);
  const id=f.sm.appendMessage({role:'assistant',content:[{type:'text',text:'已保存正文。'}],timestamp:Date.now(),stopReason:'stop',details:{rpNarrative:'已保存正文。',rpAuthorDraft:'<content>已保存正文。</content>',rpGenerationMode:'direct'}}as never);
  f.sm.appendCustomEntry('rp-state',{characters:{},location:'书房',_diagnosticSourceEntryId:id});
  f.sm.appendCustomEntry('rp-turn-settlement',{version:1,narrativeEntryId:id,status:'pending',ledgerDone:true,worldDone:true,ecologyDone:false,presentationDone:true,degradedDomains:['ecology']});f.sm.flush();
  const before=JSON.stringify(replies(f.sm)),scope={expectedSessionId:f.sm.getSessionId(),expectedSourceEntryId:id,candidateHashes:selected};
  assert.match((await f.engine.retryPendingSettlement({...scope,expectedSessionId:'sibling'})).error??'',/会话或正文来源/);assert.equal(claims,0);
  assert.equal((await f.engine.retryPendingSettlement(scope)).error,undefined);assert.equal(claims,1);assert.equal(runs,1);assert.equal(JSON.stringify(replies(f.sm)),before);
  const receipt=f.sm.getBranch().filter((e:any)=>e.customType==='rp-npc-parallel').at(-1)as any;assert.equal(receipt.data.status,'accepted');assert.equal(receipt.data.admissionOnly,true);assert.equal(receipt.data.calls,1);
  const ec=f.sm.getBranch().filter((e:any)=>e.customType==='rp-ecology-state').at(-1)as any;assert.equal(ec.data.round,3);
  assert.equal((await f.engine.retryPendingSettlement(scope)).error,undefined);assert.equal(claims,1);assert.equal(runs,1);
 }finally{f.cleanup()}
});
