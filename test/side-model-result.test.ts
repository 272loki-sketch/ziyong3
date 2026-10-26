import assert from "node:assert/strict";
import test from "node:test";
import { collectSideModelResult, readAssistantText } from "../server/side-model-result.ts";
import type { AssistantMsgLike, StageStreamEvent } from "../src/stage/engine.ts";
const final: AssistantMsgLike = { role: "assistant", content: [{ type: "text", text: "line one\nline two" }], stopReason: "stop" };
function stream(events: StageStreamEvent[], result = final) {
	return { async *[Symbol.asyncIterator]() { yield* events; }, async result() { return result; } };
}
test("side model forwards SDK text_delta, not thinking or tool events", async () => {
	const deltas: unknown[] = [];
	assert.equal(await collectSideModelResult(stream([{ type: "text_delta", delta: "line one\n" }, { type: "thinking_delta", delta: "PRIVATE REASONING" }, { type: "toolcall_delta", delta: "NOT REPLY" }, { type: "text_delta", delta: "line two" }, { type: "done", message: final }]), { onDelta: event => deltas.push(event) }), final);
	assert.deepEqual(deltas, [{ kind: "text", delta: "line one\n" }, { kind: "text", delta: "line two" }]);
});
test("non-stream result reports provider errors rather than parsing partial content as success", async () => {
	await assert.rejects(collectSideModelResult(stream([], { ...final, stopReason: "error", errorMessage: "fixture provider failure" }), { forceNonStreaming: true }), /fixture provider failure/);
	await assert.rejects(collectSideModelResult(stream([{ type: "error", error: { ...final, stopReason: "error", errorMessage: "fixture SSE failure" } }])), /fixture SSE failure/);
});
test("missing done fails explicitly", async () => {
	await assert.rejects(collectSideModelResult(stream([{ type: "text_delta", delta: "{" }])), /最终消息/);
});
test("side text reads only typed text blocks, never thinking or tool payloads", () => {
	const content = [
		{ type: "thinking", text: "PRIVATE", value: "PRIVATE" },
		{ type: "toolCall", text: "TOOL", content: "TOOL", value: "TOOL" },
		{ type: "text", text: "line one\n" },
		{ type: "toolResult", text: "RESULT" },
		{ type: "text", value: "NOT TEXT" },
		{ type: "text", text: "line two" },
	];
	assert.equal(readAssistantText({ ...final, content }), "line one\nline two");
	assert.equal(readAssistantText({ ...final, content: content.slice(0, 2) }), "");
});
test("side text retains legacy untyped plain text representations", () => {
	for (const fields of [{ text: " legacy " }, { content: " legacy " }, { content: [" le", { text: "g" }, { content: "a" }, { value: "cy " }] }]) {
		assert.equal(readAssistantText({ role: "assistant", ...fields } as unknown as AssistantMsgLike), "legacy");
	}
});
test("side model rejects explicit failure envelopes in streaming and non-streaming terminals", async () => {
	for (const text of [
		"[ProxySystem Error] fixture unavailable",
		'{"error":{"message":"fixture unavailable","type":"api_error"}}',
		'{"message":"fixture throttled","status":429}',
		"finish_reason: content_filter",
	]) {
		const message = { ...final, content: [{ type: "text", text }] };
		for (const forceNonStreaming of [false, true]) {
			await assert.rejects(collectSideModelResult(stream([{ type: "done", message }], message), { forceNonStreaming }), error => error instanceof Error && error.message === text);
		}
	}
});
test("ordinary story text and JSON error fields are not provider failures", async () => {
	for (const text of [
		'The console showed [ProxySystem Error], but the story continued.',
		'{"error":"The character made a mistake"}',
		'{"error":{"message":"A fictional error"},"story":"She closed the console."}',
		'```json\n{"error":{"message":"quoted fixture","type":"api_error"}}\n```',
	]) {
		const message = { ...final, content: [{ type: "text", text }] };
		assert.equal(await collectSideModelResult(stream([{ type: "done", message }])), message);
	}
});
test("tool-only terminals remain valid for collectors but do not supply side text", async () => {
	const message = { ...final, stopReason: "toolUse", content: [{ type: "toolCall", id: "fixture", name: "lookup", arguments: {}, text: "NOT REPLY" }] };
	assert.equal(await collectSideModelResult(stream([{ type: "done", message }])), message);
	assert.equal(readAssistantText(message), "");
});
test("terminal error or abort never accepts partial text as success", async () => {
	for (const stopReason of ["error", "aborted"]) {
		const message = { ...final, stopReason };
		for (const forceNonStreaming of [false, true]) {
			await assert.rejects(collectSideModelResult(stream([{ type: "done", message }], message), { forceNonStreaming }), new RegExp(`stopReason=${stopReason}`));
		}
	}
});
test("cancellation stops a pending stream next() even if upstream ignores the signal", async () => {
	const controller = new AbortController();
	const pending = { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<StageStreamEvent>>(() => undefined) }; }, result: async () => final };
	const run = collectSideModelResult(pending, { signal: controller.signal });
	const rejected = assert.rejects(run, /cancel fixture/);
	controller.abort(new Error("cancel fixture")); await rejected;
});
