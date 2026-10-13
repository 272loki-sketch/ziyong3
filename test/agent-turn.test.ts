import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runAgentTurn, authorDraftHasUnclosedContainer, type AgentTurnOptions } from "../src/stage/agent-turn.ts";
import { DIRECTOR_ROLES, type DirectorReport, type DirectorPhase } from "../src/stage/agent-director.ts";
import { generationWorkflowView } from "../src/stage/generation-mode.ts";

function stream(responses: any[], contexts: any[]) {
	return (context: any) => {
		contexts.push(context);
		const response = responses.shift();
		if (!response) throw new Error("unexpected model request");
		const message = { role: "assistant", content: response.calls ? response.calls.map((call: any, index: number) => ({ type: "toolCall", id: `call-${index}`, name: call.name, arguments: call.args ?? {} })) : [{ type: "text", text: response.text ?? "" }], stopReason: response.stopReason ?? (response.aborted ? "aborted" : response.error ? "error" : response.calls ? "toolUse" : "stop"), ...(response.error ? { errorMessage: response.error } : {}) };
		return { async *[Symbol.asyncIterator]() { if (response.text) yield { type: "text_delta", delta: response.text }; response.beforeEnd?.(); if (response.throw) throw new Error(response.throw); yield response.error ? { type: "error", error: message } : { type: "done", message }; }, async result() { return message; } } as never;
	};
}
const consult = (phase: DirectorPhase) => ({ calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "本拍资料分析" })) } }] });
function fixture(responses: any[], mode: "direct" | "director" = "director") {
	const contexts: any[] = [], expertCalls: any[] = [], displayed: string[] = [], revised: string[] = [];
	const options: AgentTurnOptions = { mode, systemPrompt: "预设原文", messages: [], directorPrompt: "流程协议", readTools: [],
		stream: stream(responses, contexts), read: async () => ({ text: "readonly" }), isCurrent: () => true,
		experts: async (phase, tasks, draft) => { expertCalls.push({ phase, tasks, draft }); return tasks.map(task => ({ role: task.role, status: "success", summary: "完成", facts: [], inferences: [], candidates: [], issues: [] })) as DirectorReport[]; },
		onDelta: text => displayed.push(text), onResync: text => revised.push(text) };
	return { options, contexts, expertCalls, displayed, revised };
}

test("单Agent正文直出不经过稿纸工具，不施加转场/长段词语门禁", async () => {
	const text = '“第二天再谈。”她走向教室的窗边。' + "长句自然延伸。".repeat(30);
	const f = fixture([{ text }], "direct");const out = await runAgentTurn(f.options);
	assert.equal(out.narrative, text);assert.equal(out.aborted, false);assert.equal(f.contexts.length, 1);assert.equal(f.expertCalls.length, 0);assert.equal(f.displayed.join(""), text);
	assert.equal(f.contexts[0].tools, undefined);
});

test("导演固定3/2/2专家阶段，只有main普通文本成为正文，不强制修订", async () => {
	const f = fixture([consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "正文原稿。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(out.narrative, "正文原稿。");
	assert.deepEqual(f.expertCalls.map(x => [x.phase, x.tasks.length]), [["evidence", 3], ["ideas", 2], ["review", 2]]);
	assert.equal(f.expertCalls[2].draft, "正文原稿。");assert.equal(f.displayed.join(""), "正文原稿。");assert.equal(f.contexts[3].tools, undefined);
	assert.equal(out.workflow.stages.filter(x => x.stage === "revision").length, 0);
});

test("未完成固定阶段不能提前finalize或写稿", async () => {
	const f = fixture([{ calls: [{ name: "finalize" }, { name: "begin_narrative" }] }, consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "有效草稿。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.narrative, "有效草稿。");assert.equal(out.aborted, false);
	assert.match(JSON.stringify(f.contexts[1].messages), /不允许越过固定阶段/);
});

test("只读专家report不能自行改稿，main在审阅之后才可原子改稿", async () => {
	const f = fixture([consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "他把信放在桌上。" }, consult("review"), { calls: [{ name: "apply_draft_edits", args: { edits: [{ old: "桌上", new: "内袋" }] } }] }, { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.narrative, "他把信放在内袋。");assert.deepEqual(f.revised, ["他把信放在内袋。"]);assert.equal(out.aborted, false);
});

test("非法缺角色batch不执行专家，下一轮可恢复完整固定阶段", async () => {
	const f = fixture([{ calls: [{ name: "consult_experts", args: { tasks: [{ role: "continuity", task: "少项" }] } }] }, consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "正文。" }, consult("review"), { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(f.expertCalls.length, 3);assert.match(JSON.stringify(f.contexts[1].messages), /必须恰好包含/);
});

test("无工具API仍执行导演3/2/2，不伪造工具调用或自动改成direct", async () => {
	const f = fixture([{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "沿当前话题观察人物的不同反应" }, { role: "idea-b", task: "沿场景中的生活事务组织本拍" }] }) }, { text: "原始正文。" }, { text: '{"decision":"keep"}' }]);f.options.toolsSupported = false;
	const out = await runAgentTurn(f.options);assert.equal(out.aborted, false);assert.equal(out.workflow.mode, "director");assert.equal(out.workflow.toolFallback, true);assert.equal(out.narrative, "原始正文。");assert.deepEqual(f.expertCalls.map(x => x.tasks.length), [3, 2, 2]);
});

test("取消保留半稿但不虚报定稿，不再执行review或finalize", async () => {
	const f = fixture([{ text: "已写出的半稿", aborted: true }], "direct");const out = await runAgentTurn(f.options);
	assert.equal(out.aborted, true);assert.equal(out.narrative, "已写出的半稿");assert.equal(out.final?.stopReason, "aborted");assert.equal(out.workflow.stages.some(x => x.stage === "finalize"), false);
});

test("Wire模式投影不透传prompt、报告、reasoning等未知字段", () => {
	const out = generationWorkflowView({ version: 1, mode: "director", writerRounds: 8, stages: [{ stage: "review", status: "success", calls: 2, prompt: "SECRET" }], reasoning: "SECRET", reports: ["SECRET"] });
	assert.ok(out);assert.doesNotMatch(JSON.stringify(out), /SECRET|prompt|reasoning|reports/);
});


test("读取工具不响应取消也不会卡住回合，晚到结果不写入上下文", async () => {
	const f = fixture([{ calls: [{ name: "world_state_get" }] }], "direct");
	f.options.readTools = [{ name: "world_state_get", description: "read", parameters: { type: "object" } }];
	f.options.read = async () => await new Promise(() => {}); f.options.timeoutMs = 25;
	const result = await runAgentTurn(f.options);assert.equal(result.aborted, true);assert.equal(result.narrative, "");assert.match(result.error ?? "", /时间预算/);
});

test("供应商标stop但对白未闭合时由同一主作者suffix接续，不截成假定稿", async()=>{
 const f=fixture([{text:'他抬起头说：“听'},{text:JSON.stringify({suffix:'我把话说完。”他收起了书。'})}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";const out=await runAgentTurn(f.options);
 assert.equal(out.aborted,false);assert.equal(out.narrative,'他抬起头说：“听我把话说完。”他收起了书。');assert.equal(f.expertCalls.length,0);assert.equal(f.contexts.length,2);
});
test("输出恢复不把等待/看向等正常词当禁词，也不擅自补写正文",async()=>{
 const f=fixture([{text:'她看向窗外，等待雨停。'}],"direct");const out=await runAgentTurn(f.options);assert.equal(out.narrative,'她看向窗外，等待雨停。');assert.equal(f.contexts.length,1);
});

test("输出恢复suffix闭合原作者正文标签，不丢掉之前已写的部分",async()=>{
 const f=fixture([{text:'<content>他说：“听'},{text:JSON.stringify({suffix:'我说完。”</content>'})}],"direct");const {extractPureTextNarrative}=await import("../src/stage/engine.ts");f.options.normalizeNarrative=extractPureTextNarrative;f.options.outputRecoveryPrompt="只返回suffix JSON";const out=await runAgentTurn(f.options);assert.equal(out.narrative,'他说：“听我说完。”');assert.equal(out.aborted,false);
});

test("机械接续协议由主作者返回suffix，原稿保持不变且无专家代写",async()=>{
 const f=fixture([{text:'他低声说：“听'},{text:'{"suffix":"我说完。”随后他收起了书。"}'}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,'他低声说：“听我说完。”随后他收起了书。');assert.equal(f.expertCalls.length,0);
});


test("供应商截断后卡格式包装的suffix回执可由原作者接续，固定审阅只在完整稿后运行", async()=>{
 const f=fixture([consult("evidence"),consult("ideas"),{calls:[{name:"begin_narrative"}]},{text:"<content>饭还在锅里",stopReason:"length"},{text:'<rule_check>原格式</rule_check><content>{"suffix":"。随后他们一起吃完了饭。</content>"}</content>'},consult("review"),{calls:[{name:"finalize"}]}]);
 const {extractPureTextNarrative}=await import("../src/stage/engine.ts");f.options.normalizeNarrative=extractPureTextNarrative;f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,"饭还在锅里。随后他们一起吃完了饭。");
 assert.equal(out.authorDraft,"<content>饭还在锅里。随后他们一起吃完了饭。</content>");assert.equal(f.expertCalls.filter(c=>c.phase==="review").length,1);
});

test("坏补全回执有界重试同一主作者，不重写已有草稿、不让专家代写",async()=>{
 const f=fixture([{text:"饭还在锅里",stopReason:"length"},{text:'{"suffix":'},{text:'{"suffix":"。随后他们一起吃完了饭。"}'}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,"饭还在锅里。随后他们一起吃完了饭。");assert.equal(f.contexts.length,3);assert.equal(f.expertCalls.length,0);
  assert.match(JSON.stringify(f.contexts[2].messages),/validation_errors/);
  assert.ok(f.contexts[2].messages.some((m:any)=>m.role==="assistant"&&m.content.some((p:any)=>p.text==='{"suffix":')));
  assert.match(f.contexts[2].messages.at(-1).content[0].text,/优先于原格式输出合同/);
});

test("再次截断的补全回执不冒充完整稿，失败分类与每次停止原因留痕",async()=>{
 const f=fixture([{text:"未完成",stopReason:"length"},{text:'{"suffix":"残片"}',stopReason:"length"},{text:'{"suffix":"。已完成。"}'}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,"未完成。已完成。");
 assert.deepEqual(out.workflow.writerCalls?.map(c=>c.stopReason),["length","length","stop"]);assert.equal(out.workflow.recovery?.invalidReceipts,1);
});

test("两次无效回执保留原稿、明确失败，不伪造suffix或无限请求",async()=>{
 const f=fixture([{text:"未完成",stopReason:"length"},{text:"无效回执一"},{text:"无效回执二"}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,true);assert.equal(out.narrative,"未完成");assert.match(out.error??"",/输出恢复回执/);assert.equal(f.contexts.length,3);assert.equal(out.workflow.recovery?.status,"failed");
});


test("补全只移除导演控制回执，保留原输入/全部已送达报告，避免跨上下文usage把输出额度压到1",async()=>{
 const {clampMaxTokensToContext}=await import("../packages/ai/src/api/simple-options.ts");
 const f=fixture([consult("evidence"),consult("ideas"),{calls:[{name:"begin_narrative"}]},{text:"合成故事尚未结束",stopReason:"length"},{text:'{"suffix":"。随后他们一起吃完了饭。"}'},consult("review"),{calls:[{name:"finalize"}]}]);
 f.options.messages=[{role:"user",content:[{type:"text",text:"合成原始输入：做完后一起吃"}],timestamp:0}];f.options.outputRecoveryPrompt="只返回suffix JSON";
 const base=f.options.stream;
 f.options.stream=(ctx,signal)=>{
  const budget={requestedMaxTokens:16384,actualMaxTokens:clampMaxTokensToContext({contextWindow:128000} as never,ctx as never,16384)};
  const stream=base(ctx,signal);
  return{requestBudget:budget,async *[Symbol.asyncIterator](){for await(const event of stream){if(event.type==="done"&&event.message)event.message.usage={input:123999,output:20,totalTokens:124019};yield event;}},result:()=>stream.result()};
 };
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false,out.error);
 const repair=out.workflow.writerCalls?.find(c=>c.phase==="recovery");assert.equal(repair?.actualMaxTokens,16384);
 const repairContext=f.contexts[(repair?.round??0)-1];assert.match(JSON.stringify(repairContext.messages),/合成原始输入/);assert.match(JSON.stringify(repairContext.messages),/完成/);
 assert.equal(repairContext.messages.some((m:any)=>m.role==="toolResult"||(m.usage?.totalTokens??0)>0),false);
 assert.ok(out.workflow.writerCalls?.some(c=>c.phase!=="recovery"&&c.actualMaxTokens!<1000));
});

test("无原生tools路径遇length时同样恢复后才进入review，不把截断稿直接定稿",async()=>{
 const f=fixture([{text:JSON.stringify({tasks:[{role:"idea-a",task:"观察已有对话"},{role:"idea-b",task:"观察已有事务"}]})},{text:"他们正在准备晚饭",stopReason:"length"},{text:'{"suffix":"，随后一起吃完了饭。"}'},{text:'{"decision":"keep"}'}]);
 f.options.toolsSupported=false;f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.workflow.recovery?.status,"success");assert.match(out.narrative,/吃完了饭/);assert.equal(f.expertCalls.filter(c=>c.phase==="review").length,1);
});

test("补全JSON不能携带完整原稿来重写或重复原文",async()=>{
 const prefix="已接受的原作者文字。".repeat(6);
 const f=fixture([{text:prefix,stopReason:"length"},{text:JSON.stringify({suffix:prefix+"新尾巴"})},{text:JSON.stringify({suffix:"接续的尾巴。"})}],"direct");f.options.outputRecoveryPrompt="只返回suffix JSON";
 const out=await runAgentTurn(f.options);assert.equal(out.aborted,false);assert.equal(out.narrative,prefix+"接续的尾巴。");assert.equal(out.workflow.recovery?.lastValidation,"duplicate-draft");
});

test("new recovery diagnostics whitelist scalar budget/validation data and never expose private receipt content",()=>{
 const out=generationWorkflowView({version:1,mode:"director",writerRounds:2,toolFallback:false,stages:[],recovery:{reason:"provider-length",status:"failed",attempts:2,invalidReceipts:2,lastValidation:"invalid-json",rawReply:"PRIVATE_RAW",prompt:"PRIVATE_PROMPT"},writerCalls:[{round:2,phase:"recovery",stopReason:"length",textChars:71,requestedMaxTokens:16384,actualMaxTokens:49,rawReply:"PRIVATE_RAW",thinking:"PRIVATE_THINKING"}]});
 assert.ok(out);assert.equal(out.writerCalls?.[0].actualMaxTokens,49);assert.equal(out.recovery?.lastValidation,"invalid-json");assert.doesNotMatch(JSON.stringify(out),/PRIVATE_|rawReply|thinking|prompt/);
});

for (const mode of ["direct", "director"] as const) for (const toolsSupported of [true, false]) {
	for (const raw of ["<unlisted-before>合成附属格式</unlisted-before>\n<content>合成正文。</content>\n<unlisted-after>{\"delta\":1}</unlisted-after>", "只有合成正文。"])
		test(`${mode}/${toolsSupported ? "native" : "fallback"}：统一交付合同保留未知格式，缺格式不门禁或增加调用（${raw.startsWith("<") ? "完整" : "缺格式"}）`, async () => {
			const responses = mode === "direct" ? [{ text: raw }] : toolsSupported
				? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: raw }, consult("review"), { calls: [{ name: "finalize" }] }]
				: [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "观察对话" }, { role: "idea-b", task: "观察事务" }] }) }, { text: raw }, { text: '{"decision":"keep"}' }];
			const expectedCalls = responses.length;
			const f = fixture(responses, mode);
			const systemPrompt = "原始预设\n<unlisted-before>原始格式要求</unlisted-before>";
			const messages = [
				{ role: "user", content: [{ type: "text", text: "合成历史输入" }] },
				{ role: "assistant", content: [{ type: "text", text: "合成历史回复" }] },
				{ role: "user", content: [{ type: "text", text: "合成插件 depth 材料：保留原标签及位置" }] },
				{ role: "user", content: [{ type: "text", text: "合成本拍原用户输入" }] },
			];
			const originalMessages = structuredClone(messages);
			Object.assign(f.options, { systemPrompt, messages, toolsSupported });
			const out = await runAgentTurn(f.options);
			assert.equal(out.aborted, false, out.error);
			assert.equal(out.authorDraft, raw);
			assert.equal(out.narrative, raw);
			assert.equal(out.final?.content.find(x => x.type === "text")?.text, raw);
			assert.equal(f.contexts.length, expectedCalls);
			assert.equal(out.workflow.writerRounds, expectedCalls);
			assert.equal(f.expertCalls.length, mode === "director" ? 3 : 0);
			assert.equal(f.options.systemPrompt, systemPrompt);
			assert.deepEqual(messages, originalMessages);
			for (const context of f.contexts) {
				assert.ok(context.systemPrompt.startsWith(systemPrompt + "\n\n【作者交付合同】"));
				assert.match(context.systemPrompt, /普通文本是输出载体，不是仅交纯正文/);
				assert.match(context.systemPrompt, /当前启用的原始角色卡、预设和世界书/);
				assert.match(context.systemPrompt, /标签、顺序和位置由原材料决定/);
				assert.match(context.systemPrompt, /不等待拍后检查或补交/);
				assert.doesNotMatch(context.systemPrompt.slice(systemPrompt.length), /options|MVU|UpdateVariable|JSONPatch/);
				assert.deepEqual(context.messages.filter((m: unknown) => messages.includes(m as typeof messages[number])), originalMessages);
			}
			if (mode === "director" && toolsSupported) {
				for (const name of ["begin_narrative", "begin_revision"]) assert.match(f.contexts[0].tools.find((t: any) => t.name === name).description, /完整正文及.*适用附属格式/);
				assert.match(JSON.stringify(f.contexts[3].messages), /下一轮普通文本一次交付完整正文及/);
			} else if (!toolsSupported) assert.match(JSON.stringify(f.contexts[mode === "direct" ? 0 : 1].messages), /本轮一次交付完整正文及/);
		});
}

test("导演完整修订沿用交付合同及原格式，不新增拍后格式调用", async () => {
	const raw = "<unknown-card-format>合成格式</unknown-card-format>修订正文。";
	const f = fixture([consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: "初稿。" }, consult("review"), { calls: [{ name: "begin_revision" }] }, { text: raw }, { calls: [{ name: "finalize" }] }]);
	const out = await runAgentTurn(f.options);
	assert.equal(out.aborted, false, out.error);
	assert.equal(out.authorDraft, raw);
	assert.equal(f.contexts.length, 8);
	assert.match(f.contexts[6].systemPrompt, /【作者交付合同】/);
	assert.match(JSON.stringify(f.contexts[6].messages), /修订通道已开启。下一轮普通文本一次交付完整正文及/);
});

test("两份内置作者 Skill 与请求交付合同语义一致", async () => {
	for (const name of ["主演文本直出", "导演主Agent"]) {
		const skill = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
		assert.match(skill, /普通文本是输出载体，不是仅交纯正文/);
		assert.match(skill, /当前启用的原始角色卡、预设和世界书/);
		assert.match(skill, /本轮一次交付完整正文及适用附属格式/);
		assert.match(skill, /标签、顺序和位置由原材料决定，不另设格式名单/);
		assert.match(skill, /不等待拍后检查或补交格式/);
	}
});

for (const mode of ["direct", "director"] as const) for (const toolsSupported of [true, false]) {
 for (const includeTail of [true, false]) test(`${mode}/${toolsSupported ? "native" : "fallback"}: stop inside second image recovers original suffix, optional tail=${includeTail}`, async () => {
  const raw = '<content>他们吃完饭。</content>\n<image>first</image>\n<image>second';
  const suffix = ' complete</image>' + (includeTail ? '\n<options>散步</options>\n<UpdateVariable>{"delta":1}</UpdateVariable>' : '');
  const repair = { text: JSON.stringify({ suffix }) };
  const responses = mode === "direct" ? [{ text: raw }, repair] : toolsSupported
   ? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: raw }, repair, consult("review"), { calls: [{ name: "finalize" }] }]
   : [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "观察对话" }, { role: "idea-b", task: "观察事务" }] }) }, { text: raw }, repair, { text: '{"decision":"keep"}' }];
  const calls = responses.length;
  const f = fixture(responses, mode);
  const { extractPureTextNarrative } = await import("../src/stage/engine.ts");
  Object.assign(f.options, { toolsSupported, normalizeNarrative: extractPureTextNarrative, outputRecoveryPrompt: "只返回suffix JSON" });
  assert.doesNotMatch(extractPureTextNarrative(raw), /second/);
  const out = await runAgentTurn(f.options);
  assert.equal(out.aborted, false, out.error);
  assert.equal(out.authorDraft, raw + suffix);
  assert.equal(out.narrative, extractPureTextNarrative(raw + suffix));
  assert.doesNotMatch(out.narrative, /options|UpdateVariable|delta/);
  assert.equal(out.final?.content.find(x => x.type === "text")?.text, raw + suffix);
  assert.equal(f.contexts.length, calls);
  assert.equal(out.workflow.recovery?.reason, "unclosed-container");
  assert.equal(out.workflow.recovery?.status, "success");
  const recoveryRound = out.workflow.writerCalls!.find(c => c.phase === "recovery")!.round;
  const recoveryContext = f.contexts[recoveryRound - 1];
  assert.ok(recoveryContext);
  assert.equal(recoveryContext.tools, undefined);
  assert.ok(recoveryContext.messages.some((m: any) => m.role === "assistant" && m.content.some((x: any) => x.text === raw)));
  if (mode === "director") {
   assert.deepEqual(f.expertCalls.map(c => [c.phase, c.tasks.length]), [["evidence", 3], ["ideas", 2], ["review", 2]]);
   assert.equal(f.expertCalls[2].draft, raw + suffix);
  } else assert.equal(f.expertCalls.length, 0);
 });
}

for (const mode of ["direct", "director"] as const) for (const toolsSupported of [true, false]) test(`${mode}/${toolsSupported}: suffix still hanging rejects false completion before review`, async () => {
 const raw = '<content>饭已吃完。</content>\n<unknown-author-container>尚未交完';
 const repair = { text: JSON.stringify({ suffix: '，仍未闭合' }) };
 const responses = mode === "direct" ? [{ text: raw }, repair] : toolsSupported
  ? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }, { text: raw }, repair]
  : [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "观察对话" }, { role: "idea-b", task: "观察事务" }] }) }, { text: raw }, repair];
 const f = fixture(responses, mode);
 const { extractPureTextNarrative } = await import("../src/stage/engine.ts");
 Object.assign(f.options, { toolsSupported, normalizeNarrative: extractPureTextNarrative, outputRecoveryPrompt: "只返回suffix JSON" });
 const out = await runAgentTurn(f.options);
 assert.equal(out.aborted, true);
 assert.equal(out.authorDraft, raw + '，仍未闭合');
 assert.equal(out.final?.stopReason, "aborted");
 assert.equal(out.workflow.recovery?.status, "failed");
 assert.equal(out.workflow.recovery?.lastValidation, "unclosed-container");
 assert.equal(f.expertCalls.some(c => c.phase === "review"), false);
 assert.equal(out.workflow.stages.some(c => c.stage === "finalize"), false);
 assert.equal(generationWorkflowView(out.workflow)?.recovery?.lastValidation, "unclosed-container");
});

test("container boundary ignores HTML void/optional endings, self-closing and Markdown examples, but keeps unknown nested containers", () => {
 for (const text of [
  '她比较 a<b 与 c>d，随后离开。', '数值 a < b > c。', '文学<比较>不是格式。',
  '<p>段落<br><img src="x"><input disabled><li>列表', '<custom-card />', '<custom-card key="value"/>',
  '示例 `<image>unfinished`，并非作者容器。', '示例 ``<unknown>unfinished``。',
  '```xml\n<image>unfinished\n```\n正文。', '~~~xml\n<image>unfinished\n~~~\n正文。',
  '```xml\n<image>unfinished', '<!-- <image>unfinished -->正文。',
   '<unknown>完整</unknown>', '<outer><unknown>完整</unknown></outer>', '<same><same>完整</same></same>',
   '<outer><unknown>未完</outer>', '<outer><middle><child>局部缺口</outer>',
   '<outer><unknown>局部缺口</outer></unknown>',
  ]) assert.equal(authorDraftHasUnclosedContainer(text), false, text);
  for (const text of ['<unknown>未完', '<outer><unknown>未完', '<outer><unknown>完整</unknown>', '<image key="value">未完',
   '<outer><unknown>局部缺口</outer>\n<trailing-unknown>未完',
  '<p>段落\n<image>未完', '<custom-card/>\n<unknown>未完', '`<image>`\n<unknown>未完',
  '<image>未完\n```xml\n</image>\n```', '<image>未完 `</image>`', '<same><same>未完</same>']) {
  assert.equal(authorDraftHasUnclosedContainer(text), true, text);
 }
});

for (const mode of ["direct", "director"] as const) for (const toolsSupported of [true, false]) {
 for (const parentClosed of [true, false]) test(`${mode}/${toolsSupported}: synthetic 12-op patch missing child close only recovers an EOF-open parent=${!parentClosed}`, async () => {
  const patch = Array.from({ length: 12 }, (_, i) => ({ op: "replace", path: `/synthetic/${i}`, value: i }));
  const raw = '<content>合成正文已完成。</content>\n<options>合成选项</options>\n<UpdateVariable><Analysis>合成分析已完成。</Analysis><JSONPatch>\n'
   + JSON.stringify(patch) + (parentClosed ? '\n</UpdateVariable>' : '');
  assert.equal(JSON.parse(raw.slice(raw.indexOf('<JSONPatch>') + '<JSONPatch>'.length).split('</UpdateVariable>')[0]).length, 12);
  assert.equal(authorDraftHasUnclosedContainer(raw), !parentClosed);
  const suffix = '\n</JSONPatch></UpdateVariable>';
  const responses = [
   ...(mode === "direct" ? [] : toolsSupported
    ? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }]
    : [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "观察对话" }, { role: "idea-b", task: "观察事务" }] }) }]),
   { text: raw },
   ...(parentClosed ? [] : [{ text: JSON.stringify({ suffix }) }]),
   ...(mode === "direct" ? [] : toolsSupported ? [consult("review"), { calls: [{ name: "finalize" }] }] : [{ text: '{"decision":"keep"}' }]),
  ];
  const calls = responses.length;
  const f = fixture(responses, mode);
  const { extractPureTextNarrative } = await import("../src/stage/engine.ts");
  Object.assign(f.options, { toolsSupported, normalizeNarrative: extractPureTextNarrative, outputRecoveryPrompt: "只返回suffix JSON" });
  const out = await runAgentTurn(f.options);
  const expected = raw + (parentClosed ? '' : suffix);
  assert.equal(out.aborted, false, out.error);
  assert.equal(out.error, undefined);
  assert.equal(out.authorDraft, expected);
  assert.equal(out.final?.stopReason, "stop");
  assert.equal(out.final?.content.find(x => x.type === "text")?.text, expected);
  assert.equal(out.narrative, extractPureTextNarrative(expected));
  assert.equal(f.contexts.length, calls);
  assert.equal(out.workflow.writerCalls?.filter(c => c.phase === "recovery").length, parentClosed ? 0 : 1);
  if (parentClosed) {
   assert.equal(out.workflow.recovery, undefined);
   assert.deepEqual(f.revised, []);
   assert.equal(f.displayed.join(""), raw);
  } else assert.equal(out.workflow.recovery?.status, "success");
  if (mode === "director") {
   assert.deepEqual(f.expertCalls.map(c => [c.phase, c.tasks.length]), [["evidence", 3], ["ideas", 2], ["review", 2]]);
   assert.equal(f.expertCalls[2].draft, expected);
  } else assert.equal(f.expertCalls.length, 0);
 });
}

test("builtin recovery allows same-author container closure without required-format checks", async () => {
 const skill = await readFile(new URL("../skills/主演输出恢复/SKILL.md", import.meta.url), "utf8");
 assert.match(skill, /已经实际开启的标签容器/);
 assert.match(skill, /片段可以包含原作者附属格式及闭合标签/);
 assert.match(skill, /不检查要求的格式是否出现/);
  assert.match(skill, /不重演已有事实/);
  assert.match(skill, /只检测可从原稿 EOF 追加接续的开放结构/);
  assert.match(skill, /父容器已经闭合/);
 assert.doesNotMatch(skill, /输出任何状态栏\/插图/);
});

for (const mode of ["direct", "director"] as const) for (const toolsSupported of [true, false]) {
 const setup = () => mode === "direct" ? [] : toolsSupported
  ? [consult("evidence"), consult("ideas"), { calls: [{ name: "begin_narrative" }] }]
  : [{ text: JSON.stringify({ tasks: [{ role: "idea-a", task: "对话" }, { role: "idea-b", task: "事务" }] }) }];
 const finish = () => mode === "direct" ? [] : toolsSupported ? [consult("review"), { calls: [{ name: "finalize" }] }] : [{ text: '{"decision":"keep"}' }];
 for (const timeout of ["Stream timeout", "Queue timeout", "transport timed out"]) {
  test(`${mode}/${toolsSupported}: ${timeout} partial suffix success preserves raw and reports`, async () => {
   const raw = '<content>已收到的正文。\n  ', suffix = '接续末尾。</content>';
   const f = fixture([...setup(), { text: raw, error: timeout }, { text: JSON.stringify({ suffix }) }, ...finish()], mode);
   Object.assign(f.options, { toolsSupported, outputRecoveryPrompt: "只返回suffix JSON", messages: [{ role: "user", content: [{ type: "text", text: "完整输入：做完后吃饭" }] }], normalizeNarrative: (text:string) => text.replace(/<[^>]*>/g, "").trim() });
   const out = await runAgentTurn(f.options);
   assert.equal(out.aborted, false, out.error); assert.equal(out.authorDraft, raw + suffix);
   assert.equal(out.workflow.recovery?.reason, "transport-interrupted"); assert.equal(generationWorkflowView(out.workflow)?.recovery?.reason, "transport-interrupted");
   const ctx = f.contexts[out.workflow.writerCalls!.find(c => c.phase === "recovery")!.round - 1];
   assert.match(JSON.stringify(ctx.messages), /完整输入：做完后吃饭/);
   assert.ok(ctx.messages.some((m:any) => m.role === "assistant" && m.content[0].text === raw));
   if (mode === "director") { assert.match(JSON.stringify(ctx.messages), /完成/); assert.equal(f.expertCalls.at(-1).draft, raw + suffix); }
   assert.equal(f.displayed.join(""), raw); assert.deepEqual(f.revised, [raw + suffix]);
  });
 }
 test(`${mode}/${toolsSupported}: partial timeout recovery fails bounded, no review/finalize`, async () => {
  const raw = '<content>保留半稿  ';
  const f = fixture([...setup(), { text: raw, error: "Stream timeout" }, { text: "裸全文一" }, { text: "裸全文二" }], mode);
  Object.assign(f.options, { toolsSupported, outputRecoveryPrompt: "只返回suffix JSON" });
  const out = await runAgentTurn(f.options);
  assert.equal(out.aborted, true); assert.equal(out.authorDraft, raw); assert.equal(out.workflow.recovery?.attempts, 2);
  assert.equal(out.workflow.stages.some(s => s.stage === "finalize" || s.stage === "review"), false);
  assert.equal(f.contexts.length, setup().length + 3);
 });
 test(`${mode}/${toolsSupported}: zero-text timeout retries fresh stream only once`, async () => {
  const f = fixture([...setup(), { error: "Queue timeout" }, { text: "完整正文。" }, ...finish()], mode);
  Object.assign(f.options, { toolsSupported, outputRecoveryPrompt: "只返回suffix JSON" });
  const out = await runAgentTurn(f.options);
  assert.equal(out.aborted, false, out.error); assert.equal(out.authorDraft, "完整正文。"); assert.equal(out.workflow.recovery, undefined);
  const failed = fixture([...setup(), { throw: "transport timeout" }, { error: "Stream timeout" }], mode);
  Object.assign(failed.options, { toolsSupported, outputRecoveryPrompt: "只返回suffix JSON" });
  const result = await runAgentTurn(failed.options);
  assert.equal(result.aborted, true); assert.equal(failed.contexts.length, setup().length + 2);
 });
 for (const stop of ["cancel", "scope", "auth", "cap", "context", "aborted"]) test(`${mode}/${toolsSupported}: ${stop} never transport-retries`, async () => {
  const controller = new AbortController(); let current = true;
  const errors:Record<string,string> = { auth: "401 auth: Stream timeout", cap: "model capability: Queue timeout", context: "context length limit: Stream timeout" };
  const f = fixture([...setup(), { text: "半稿", error: errors[stop] ?? "Stream timeout", ...(stop === "aborted" ? { stopReason: "aborted" } : {}), beforeEnd: () => { if (stop === "cancel") controller.abort(); if (stop === "scope") current = false; } }], mode);
  Object.assign(f.options, { toolsSupported, outputRecoveryPrompt: "只返回suffix JSON", signal: controller.signal, isCurrent: () => current });
  const out = await runAgentTurn(f.options);
  assert.equal(out.aborted, true); assert.equal(out.authorDraft, "半稿"); assert.equal(f.contexts.length, setup().length + 1);
  assert.equal(out.workflow.stages.some(s => s.stage === "finalize" || s.stage === "review"), false);
 });
}

test("unclosed draft without recovery protocol rejects bare continuation", async () => {
 const f = fixture([{ text: '<content>半稿' }], "direct");
 const out = await runAgentTurn(f.options);
 assert.equal(out.aborted, true); assert.equal(out.authorDraft, '<content>半稿'); assert.equal(f.contexts.length, 1);
});

test("failed receipt context is bounded and never appended to original raw draft", async () => {
 const invalid = "invalid-receipt-".repeat(2000);
 const f = fixture([{ text: "原稿", stopReason: "length" }, { text: invalid }, { text: '{"suffix":"结束。"}' }], "direct");
 f.options.outputRecoveryPrompt = "只返回suffix JSON";
 const out = await runAgentTurn(f.options);
 assert.equal(out.authorDraft, "原稿结束。");
 const failed = f.contexts[2].messages.filter((m:any) => m.role === "assistant" && m.content[0].text.startsWith("invalid-receipt-"));
 assert.equal(failed.length, 1); assert.equal(failed[0].content[0].text.length, 12000);
 assert.equal(failed[0].usage.totalTokens, 0);
});

test("transport failure during suffix recovery preserves raw and never retries transport", async () => {
 const raw = '<content>半稿\n  ';
 const f = fixture([{ text: raw, error: "Stream timeout" }, { text: '{"suffix":"不可采用', error: "Queue timeout" }], "direct");
 Object.assign(f.options, { outputRecoveryPrompt: "只返回suffix JSON", normalizeNarrative: () => "事实投影" });
 const out = await runAgentTurn(f.options);
 assert.equal(out.aborted, true); assert.equal(out.authorDraft, raw); assert.equal(f.contexts.length, 2);
 assert.equal(out.workflow.recovery?.status, "failed"); assert.equal(out.workflow.stages.length, 0);
});

test("short partial draft is also protected against full-draft replay", async () => {
 const f = fixture([{ text: "短原稿", error: "Stream timeout" }, { text: '{"suffix":"短原稿重复全文。"}' }, { text: '{"suffix":"接续结束。"}' }], "direct");
 f.options.outputRecoveryPrompt = "只返回suffix JSON";
 const out = await runAgentTurn(f.options);
 assert.equal(out.aborted, false); assert.equal(out.authorDraft, "短原稿接续结束。");
 assert.equal(out.workflow.recovery?.lastValidation, "duplicate-draft");
});
