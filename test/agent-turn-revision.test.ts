import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn, type AgentTurnOptions } from "../src/stage/agent-turn.ts";
import { DIRECTOR_ROLES, type DirectorReport, type DirectorPhase } from "../src/stage/agent-director.ts";

// Synthetic streaming fixtures, including terminal corrections and interruption.
function fixture(responses: any[]) {
	let displayed = "";
	const revised: string[] = [];
	const options: AgentTurnOptions = {
		mode: "director", systemPrompt: "synthetic preset", messages: [], directorPrompt: "synthetic protocol",
		readTools: [{ name: "read_source", description: "read", parameters: { type: "object" } }],
		stream: () => {
			const response = responses.shift();
			if (!response) throw new Error("unexpected model request");
			const message = { role: "assistant", content: [
				...(!response.calls || response.text !== undefined ? [{ type: "text", text: response.terminalText ?? response.text ?? "" }] : []),
				...(response.calls ?? []).map((call: any, index: number) => ({ type: "toolCall", id: `call-${index}`, name: call.name, arguments: call.args ?? {} })),
			], stopReason: response.stopReason ?? (response.error ? "error" : response.calls ? "toolUse" : "stop"), ...(response.error ? { errorMessage: response.error } : {}) };
			return { async *[Symbol.asyncIterator]() {
				for (const delta of response.deltas ?? [response.text]) if (delta) yield { type: "text_delta", delta };
				response.beforeEnd?.();
				if (response.throw) throw new Error(response.throw);
				yield response.error ? { type: "error", error: message } : { type: "done", message };
			}, async result() { return message; } } as never;
		},
		read: async () => ({ text: "readonly" }), isCurrent: () => true,
		experts: async (_phase, tasks) => tasks.map(task => ({ role: task.role, status: "success", summary: "done", facts: [], inferences: [], candidates: [], issues: [] })) as DirectorReport[],
		onDelta: (text, reset) => { displayed = (reset ? "" : displayed) + text; },
		onResync: text => { revised.push(text); displayed = text; },
	};
	return { options, revised, displayed: () => displayed };
}
const call = (name: string) => ({ calls: [{ name }] });
const consult = (phase: DirectorPhase) => ({ calls: [{ name: "consult_experts", args: { tasks: DIRECTOR_ROLES[phase].map(role => ({ role, task: "synthetic brief" })) } }] });
const BASE = "The earlier draft remains the author's choice. ".repeat(30);
const RAW = " \t<content>雨停了。她收起伞，走过空荡的桥。🪷</content>\r\n";
const setup = () => [consult("evidence"), consult("ideas"), call("begin_narrative"), { text: BASE }, consult("review"), call("begin_revision")];
const adjacent = (text: string) => ({ text, ...call("read_source") });
function check(out: Awaited<ReturnType<typeof runAgentTurn>>, f: ReturnType<typeof fixture>, expected: string, aborted = false) {
	assert.equal(out.aborted, aborted, out.error);
	assert.equal(out.authorDraft, expected);
	assert.equal(out.narrative, expected);
	assert.equal(out.final?.content.find(x => x.type === "text")?.text, expected);
	assert.equal(out.final?.stopReason, aborted ? "aborted" : "stop");
	assert.equal(f.displayed(), expected, "stream/resync projection must match the returned draft");
	assert.equal(out.workflow.stages.some(s => s.stage === "finalize"), !aborted);
}

for (const terminal of ["streamed", "corrected", "terminal-only"] as const) {
	test(`exact tool-adjacent replacement is delivered once with raw author bytes (${terminal})`, async () => {
		const f = fixture([...setup(), adjacent(RAW), call("read_source"),
			{ text: terminal === "streamed" ? RAW : terminal === "corrected" ? "provisional stream" : "", terminalText: RAW }, call("finalize")]);
		const out = await runAgentTurn(f.options);
		check(out, f, RAW);
		assert.equal(f.revised.at(-1), RAW);
		assert.deepEqual(out.workflow.stages.filter(s => s.stage === "revision").map(s => s.status), ["success"]);
	});
}

test("a final replacement exactly matching multiple tool-adjacent fragments is delivered once", async () => {
	const f = fixture([...setup(), adjacent(RAW.slice(0, 19)), adjacent(RAW.slice(19)), { text: RAW }, call("finalize")]);
	check(await runAgentTurn(f.options), f, RAW);
});

const opening = "A shared opening is not proof that the remaining author text is repeated. ".repeat(2);
for (const [label, first, next] of [
	["same opening, different endings", opening + "First ending.\n", opening + "Second ending.\n"],
	["contains earlier text", RAW, "A framing paragraph.\n" + RAW + "A coda.\n"],
	["starts with earlier text", RAW, RAW + "A distinct following paragraph.\n"],
	["different boundary whitespace", RAW, "\n" + RAW],
	["genuine split container", " \t<content>雨停了。", " 她收起伞。</content>\r\n"],
] as const) {
	test(`non-identical revision fragments preserve every byte (${label})`, async () => {
		const f = fixture([...setup(), adjacent(first), { text: next }, call("finalize")]);
		check(await runAgentTurn(f.options), f, first + next);
	});
}

test("equal tool-adjacent fragments are not silently discarded", async () => {
	const first = "A repeated refrain.\n", ending = "Then the scene ends.\n";
	const f = fixture([...setup(), adjacent(first), adjacent(first), { text: ending }, call("finalize")]);
	check(await runAgentTurn(f.options), f, first + first + ending);
});

test("a short complete replacement is still an author decision", async () => {
	const f = fixture([...setup(), { text: "雨停了。" }, call("finalize")]);
	check(await runAgentTurn(f.options), f, "雨停了。");
});

for (const stop of ["error", "aborted", "cancel", "scope", "throw"] as const) {
	for (const partial of ["exact", "shared-prefix"] as const) {
		test(`interrupted revision keeps received bytes and does not infer a replacement (${stop}, ${partial})`, async () => {
			const controller = new AbortController(); let current = true;
			const first = opening + "Earlier ending.\n";
			const text = partial === "exact" ? first : opening + "New incomplete ending";
			const f = fixture([...setup(), adjacent(first), { text, terminalText: "Not authoritative after failure.",
				...(stop === "error" ? { error: "Request failed" } : stop === "aborted" ? { stopReason: "aborted" } : stop === "throw" ? { throw: "Connection lost" } : {}),
				beforeEnd: () => { if (stop === "cancel") controller.abort(); if (stop === "scope") current = false; },
			}]);
			Object.assign(f.options, { signal: controller.signal, isCurrent: () => current });
			check(await runAgentTurn(f.options), f, first + text, true);
		});
	}
}

test("a length-limited repeated response remains a partial continuation", async () => {
	const f = fixture([...setup(), adjacent(RAW), { text: RAW, stopReason: "length" }]);
	check(await runAgentTurn(f.options), f, RAW + RAW, true);
});

for (const recovery of ["unavailable", "failed", "success"] as const) {
	test(`exact repeated revision resyncs before structural recovery (${recovery})`, async () => {
		const partial = " \t<content>雨停了。", suffix = " 她收起伞。</content>\r\n";
		const f = fixture([...setup(), adjacent(partial), { text: partial },
			...(recovery === "unavailable" ? [] : recovery === "failed" ? [{ error: "Recovery request failed" }] : [{ text: JSON.stringify({ suffix }) }, consult("review"), call("finalize")])]);
		if (recovery !== "unavailable") f.options.outputRecoveryPrompt = "Return suffix JSON";
		const out = await runAgentTurn(f.options);
		check(out, f, recovery === "success" ? partial + suffix : partial, recovery !== "success");
		assert.equal(f.revised[0], partial, "remove duplicate preview even if completion fails");
		assert.equal(out.workflow.recovery?.status, recovery === "unavailable" ? undefined : recovery);
	});
}
