import assert from "node:assert/strict";
import test from "node:test";
import { collectSideModelResult } from "../server/side-model-result.ts";
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
test("cancellation stops a pending stream next() even if upstream ignores the signal", async () => {
	const controller = new AbortController();
	const pending = { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<StageStreamEvent>>(() => undefined) }; }, result: async () => final };
	const run = collectSideModelResult(pending, { signal: controller.signal });
	const rejected = assert.rejects(run, /cancel fixture/);
	controller.abort(new Error("cancel fixture")); await rejected;
});
