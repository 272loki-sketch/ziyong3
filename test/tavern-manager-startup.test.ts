import assert from "node:assert/strict";
import test from "node:test";
import { ensureManagerWorker } from "../web/public/tavern-compat/settings-ui.js";
import { sharedStatusRequest } from "../web/src/plugins/status-request.ts";

const origin = "https://synthetic.invalid", workerURL = `${origin}/tavern-plugin-sw.js`;
class WorkerFixture extends EventTarget {
	controller: { scriptURL: string } | null = null;
	registers = 0; readyReads = 0;
	get ready(): Promise<never> { this.readyReads++; return new Promise(() => {}); }
	async register(url: string, options: { scope: string }) {
		this.registers++; assert.equal(url, workerURL); assert.equal(options.scope, "/tavern-plugin-host.html");
		queueMicrotask(() => { this.controller = { scriptURL: workerURL }; this.dispatchEvent(new Event("controllerchange")); });
	}
}

test("manager startup does not wait for an unrelated/hanging serviceWorker.ready promise", async () => {
	const worker = new WorkerFixture(); worker.controller = { scriptURL: `${origin}/sw.js` };
	assert.equal(await ensureManagerWorker(worker, origin, { timeoutMs: 100 }), true);
	assert.equal(worker.registers, 1); assert.equal(worker.readyReads, 0);
});
test("already-warm manager skips registration; unavailable, failed and timeout cases terminate", async () => {
	const warm = new WorkerFixture(); warm.controller = { scriptURL: workerURL };
	assert.equal(await ensureManagerWorker(warm, origin), true); assert.equal(warm.registers, 0);
	assert.equal(await ensureManagerWorker(undefined, origin), false);
	const failure = new WorkerFixture(); failure.register = async () => { throw Error("synthetic registration failure"); };
	assert.equal(await ensureManagerWorker(failure, origin), false);
	const blocked = new WorkerFixture(); blocked.register = async () => {};
	assert.equal(await ensureManagerWorker(blocked, origin, { timeoutMs: 10 }), false);
});
test("concurrent status reads are deduplicated without caching or accepting a pre-write promise", async () => {
	let calls = 0; const completions: Array<(value: number) => void> = [];
	const status = sharedStatusRequest(() => { calls++; return new Promise<number>(resolve => completions.push(resolve)); });
	const first = status.get(); assert.equal(status.get(), first); await Promise.resolve(); assert.equal(calls, 1);
	status.invalidate(); const second = status.get(); assert.notEqual(second, first); await Promise.resolve();
	completions[0](1); assert.equal(await first, 1); assert.equal(status.get(), second);
	completions[1](2); assert.equal(await second, 2);
	const third = status.get(); await Promise.resolve(); assert.equal(calls, 3); completions[2](3); assert.equal(await third, 3);
});
test("failed status reads are not retained as a permanent failed cache", async () => {
	let calls = 0; const status = sharedStatusRequest(async () => { if (++calls === 1) throw Error("synthetic failure"); return "fresh"; });
	await assert.rejects(status.get()); assert.equal(await status.get(), "fresh");
});
