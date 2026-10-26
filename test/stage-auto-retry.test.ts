import assert from "node:assert/strict";
import test from "node:test";
import { settlementRetry, settlementFailureRetryable } from "../src/stage/settlement-retry.ts";

test("settlement wait is exactly 5000ms and abort-aware", async t => {
	t.mock.timers.enable({apis: ["setTimeout"]});
	let finished = false;
	const controller = new AbortController();
	const wait = settlementRetry.wait(controller.signal).then(() => { finished = true; });
	t.mock.timers.tick(4999); await Promise.resolve(); assert.equal(finished, false);
	t.mock.timers.tick(1); await wait; assert.equal(finished, true);
	const cancelled = settlementRetry.wait(controller.signal);
	controller.abort(); await assert.rejects(cancelled);
	await assert.rejects(settlementRetry.wait(controller.signal));
});

test("settlement failures retry only transient transport/timeout/format", () => {
	for (const error of ["network connection reset", "HTTP 503", "request timeout", "JSON/schema invalid"])
		assert.equal(settlementFailureRetryable(error), true, error);
	for (const error of ["HTTP 401 unauthorized", "schema repair HTTP 401", "schema authentication failed", "JSON credit insufficient", "JSON model not found", "insufficient_quota", "[content-filter] safety", "[ProxySystem Error] SAFETY", "JSON repair: [auth:401] unauthorized", "JSON repair: missing model", "tools are not supported", "总体预算超时", "持久额度已耗尽"])
		assert.equal(settlementFailureRetryable(error), false, error);
	assert.equal(settlementFailureRetryable("schema HTTP 503 then repair HTTP 401"), false);
});
