import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CorpusScheduler } from "../src/outline/corpus-scheduler.ts";
import type { CorpusEngine } from "../src/outline/corpus.ts";
import { ResearchSearchScheduler } from "../src/outline/research-scheduler.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext, kind: "research" | "corpus", enabled = true, fail = false) {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 8, 1, 5, 59) });
	const timers = t.mock.method(globalThis, "setTimeout");
	const gate = deferred();
	const calls: string[] = [], completed: string[] = [];
	const schedule = { enabled, hour: 6, minute: 0, maxPerRun: 2, topics: ["first", "second"], queries: ["synthetic"] };
	let scheduler: ResearchSearchScheduler | CorpusScheduler;
	let cwd: string | undefined;
	if (kind === "research") {
		cwd = mkdtempSync(join(tmpdir(), "liyuan-scheduler-lifecycle-"));
		scheduler = new ResearchSearchScheduler(cwd, schedule, async (topic) => {
			calls.push(topic);
			await gate.promise;
			if (fail) throw new Error("synthetic search failure");
			completed.push(topic);
			return {} as never;
		});
	} else {
		scheduler = new CorpusScheduler({
			schedule,
			fetchText: async (_url, signal) => {
				calls.push("search");
				await gate.promise;
				assert.equal(signal.aborted, false, "stop must not cancel the current run");
				if (fail) throw new Error("synthetic search failure");
				return '<a href="/works/111" title="Synthetic one">one</a><a href="/works/222" title="Synthetic two">two</a>';
			},
			engine: {
				view: () => ({ documents: [] }),
				createUrl: async (url: string) => { completed.push(url); },
			} as unknown as CorpusEngine,
		});
	}
	// Observe the real run promise so assertions follow the awaited timer callback,
	// without sleeps or guessing how many promise microtasks discovery needs.
	const runs = t.mock.method(scheduler, "runNow");
	const settle = async (index: number) => { await runs.mock.calls[index].result.catch(() => {}); };
	t.after(async () => {
		scheduler.stop();
		gate.resolve();
		await Promise.allSettled(runs.mock.calls.map((call) => call.result));
		scheduler.stop();
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});
	return { scheduler, schedule, gate, calls, completed, timers, runs, settle };
}

for (const kind of ["research", "corpus"] as const) {
	test(`${kind}: stop during a scheduled run lets it finish without rearming`, async (t) => {
		const f = fixture(t, kind);
		f.scheduler.start();
		t.mock.timers.tick(60_000);
		assert.equal(f.calls.length, 1);
		f.scheduler.stop();
		f.scheduler.stop();
		f.gate.resolve();
		await f.settle(0);
		assert.equal(f.completed.length, 2, "the entire current run still completes");
		assert.equal(f.schedule.enabled, true, "stop is independent of user configuration");
		assert.equal(f.timers.mock.callCount(), 1, "completion must not install another timer");
		t.mock.timers.tick(3 * 86_400_000);
		assert.equal(f.runs.mock.callCount(), 1);

		f.scheduler.start();
		f.scheduler.start();
		assert.equal(f.timers.mock.callCount(), 2);
		t.mock.timers.tick(86_400_000);
		await f.settle(1);
		assert.equal(f.completed.length, 4, "restart runs on the next scheduled day");
		assert.equal(f.timers.mock.callCount(), 3, "normal recurring scheduling still works");
	});

	test(`${kind}: restart before an old run finishes owns exactly one timer`, async (t) => {
		const f = fixture(t, kind);
		f.scheduler.start();
		f.scheduler.start();
		t.mock.timers.tick(60_000);
		assert.equal(f.calls.length, 1);
		f.scheduler.start();
		assert.equal(f.timers.mock.callCount(), 1, "start is idempotent while running");
		f.scheduler.stop();
		f.scheduler.start();
		f.scheduler.start();
		assert.equal(f.timers.mock.callCount(), 2);
		f.gate.resolve();
		await f.settle(0);
		assert.equal(f.timers.mock.callCount(), 2, "old completion must not duplicate the restart timer");
		t.mock.timers.tick(86_400_000);
		await f.settle(1);
		assert.equal(f.runs.mock.callCount(), 2);
		assert.equal(f.completed.length, 4);
		assert.equal(f.timers.mock.callCount(), 3);
		f.scheduler.stop();
		t.mock.timers.tick(3 * 86_400_000);
		assert.equal(f.runs.mock.callCount(), 2, "stop clears the sole remaining timer");
	});

	test(`${kind}: restart stays single-timer when the old run spans the next deadline`, async (t) => {
		const f = fixture(t, kind);
		f.scheduler.start();
		t.mock.timers.tick(60_000);
		f.scheduler.stop();
		f.scheduler.start();
		t.mock.timers.tick(86_400_000);
		await f.settle(1);
		assert.equal((await f.runs.mock.calls[1].result).status, "busy");
		assert.equal(f.calls.length, 1, "restart does not overlap the unfinished run");
		assert.equal(f.timers.mock.callCount(), 3);
		f.gate.resolve();
		await f.settle(0);
		assert.equal(f.completed.length, 2);
		assert.equal(f.timers.mock.callCount(), 3, "old completion preserves the new pending timer");
		f.scheduler.stop();
		t.mock.timers.tick(86_400_000);
		assert.equal(f.runs.mock.callCount(), 2);
	});

	test(`${kind}: a failed in-flight run cannot rearm after stop`, async (t) => {
		const f = fixture(t, kind, true, true);
		f.scheduler.start();
		t.mock.timers.tick(60_000);
		f.scheduler.stop();
		f.gate.resolve();
		await f.settle(0);
		assert.equal(f.completed.length, 0);
		assert.equal(f.timers.mock.callCount(), 1);
		t.mock.timers.tick(86_400_000);
		assert.equal(f.runs.mock.callCount(), 1);
	});

	test(`${kind}: stop before the deadline clears the timer; manual runs remain available`, async (t) => {
		const f = fixture(t, kind);
		f.scheduler.start();
		f.scheduler.stop();
		t.mock.timers.tick(60_000);
		assert.equal(f.calls.length, 0);
		f.gate.resolve();
		assert.equal((await f.scheduler.runNow()).status, "started");
		assert.equal(f.completed.length, 2);
		assert.equal(f.timers.mock.callCount(), 1, "manual execution does not enable recurrence");
	});

	test(`${kind}: disabled schedules stay idle and allow a manual run`, async (t) => {
		const f = fixture(t, kind, false);
		f.scheduler.start();
		t.mock.timers.tick(60_000);
		assert.equal(f.calls.length, 0);
		assert.equal(f.timers.mock.callCount(), 0);
		f.gate.resolve();
		assert.equal((await f.scheduler.runNow()).status, "started");
		assert.equal(f.completed.length, 2);
		assert.equal(f.schedule.enabled, false);
		assert.equal(f.timers.mock.callCount(), 0);
	});
}
