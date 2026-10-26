import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { StageEngine, type StageEngineDeps } from "../src/stage/engine.ts";
import { RequestJournal } from "../src/stage/request-journal.ts";
import { settlementRetry } from "../src/stage/settlement-retry.ts";
import { SUPPLEMENTARY_ENTRY_TYPE, SUPPLEMENTARY_PROTOCOL } from "../src/stage/supplementary.ts";
import { researchDirectorScript, researchEngineFixture } from "./support/research-engine-fixture.ts";

function fixture(mode: "direct" | "director", content?: unknown[], truncated?: "ecology" | "supplementary") {
	const calls: Array<{ model: string; options: Record<string, unknown> }> = [];
	const ready: string[] = [];
	class TerminalEngine extends StageEngine {
		constructor(deps: StageEngineDeps) {
			super({ ...deps, streamFn: (model, context, options) => {
				calls.push({ model: model.id, options });
				if (truncated && (truncated === "ecology" ? model.id === "ecologyRuntime" && JSON.stringify(context.messages).includes("aftermath") : context.systemPrompt === SUPPLEMENTARY_PROTOCOL)) {
					const text = truncated === "ecology"
						? '{"summary":"TRUNCATED_SIDE_SENTINEL","actors":[],"occurrences":[]}'
						: JSON.stringify({ version: 2, narrative: null, items: [{ source: "entries.0", requirement: "After the story, output a <scene_sidecar>possible next observations</scene_sidecar> block.", text: "<scene_sidecar>TRUNCATED_SIDE_SENTINEL</scene_sidecar>" }] });
					const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "length" };
					return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message } as never;
				}
				if (context.systemPrompt === SUPPLEMENTARY_PROTOCOL) {
					const message = { role: "assistant", content: [{type:'text',text:'{"version":2,"narrative":null,"items":[]}'}], stopReason: "stop" };
					return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message } as never;
				}
				if (model.id !== "scribe" || !content) return deps.streamFn(model, context, options);
				const message = { role: "assistant", content, stopReason: "stop", usage: { input: 7, output: 3 } };
				return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; }, result: async () => message } as never;
			} });
		}
	}
	const body = "Synthetic complete story.";
	const f = researchEngineFixture(mode, mode === "direct" ? [{ text: body }, { text: body }] : researchDirectorScript(body), {
		Engine: TerminalEngine,
		...(truncated === "supplementary" ? { worldText: "After the story, output a <scene_sidecar>possible next observations</scene_sidecar> block." } : {}),
		events: { onAuthorReady: () => { ready.push("author"); }, onSupplementaryReady: () => { ready.push("supplementary"); } },
	});
	if (truncated === "ecology") {
		const path = join(f.cwd, "liyuan.config.json");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), literaryEcologyEnabled: true }));
	}
	return { ...f, calls, ready, rows: () => new RequestJournal(f.cwd).list(
		{ sessionId: f.sm.getSessionId(), card: "card.json" }, new Set(f.sm.getBranch().map(entry => entry.id)),
	) };
}

for (const mode of ["direct", "director"] as const) {
	for (const side of ["ecology", "supplementary"] as const) {
		test(`${mode}: truncated ${side} cannot succeed or publish despite complete-looking text`, async t => {
			t.mock.method(settlementRetry, "wait", async () => {});
			const f = fixture(mode, undefined, side);
			try {
				await f.engine.performTurn("Continue synthetic story.");
				const phase = `settlement.${side}`;
				const rows = f.rows().filter(row => row.phase === phase && row.stopReason === "length");
				assert.ok(rows.length > 0, "must exercise the ordinary side call");
				for (const row of rows) {
					assert.equal(row.status, "failed");
					assert.equal(row.failure?.kind, "format");
					assert.equal(row.usage, undefined, "missing provider usage must remain unknown");
				}
				const branch = f.sm.getBranch() as any[];
				const authors = branch.filter(entry => entry.message?.details?.rpAuthorDraft);
				assert.equal(authors.length, 1);
				assert.equal(authors[0].message.details.rpAuthorDraft, "Synthetic complete story.");
				assert.equal(f.ready.filter(event => event === "author").length, 1, "side truncation must not block normal author delivery");
				assert.ok(!branch.some(entry => entry.customType === "rp-ecology-state" && JSON.stringify(entry.data).includes("TRUNCATED_SIDE_SENTINEL")));
				assert.ok(!branch.some(entry => entry.customType === SUPPLEMENTARY_ENTRY_TYPE && entry.data.status === "complete"));
				if (side === "supplementary") {
					const receipts = branch.filter(entry => entry.customType === SUPPLEMENTARY_ENTRY_TYPE);
					assert.equal(receipts.at(-1).data.status, "failed");
					assert.ok(receipts.every(entry => entry.data.text === undefined), "failed-result refreshes must never publish truncated text");
				}
				const diagnostics = authors[0].message.details.rpModelDiagnostics.filter((attempt: any) => attempt.phase === phase);
				assert.ok(diagnostics.length > 0);
				assert.ok(diagnostics.every((attempt: any) => attempt.status === "failed" && attempt.kind === "format"));
			} finally { f.cleanup(); }
		});
	}
}

for (const mode of ["direct", "director"] as const) {
	for (const [name, content] of [
		["empty", []],
		["whitespace", [{ type: "text", text: " \n\t" }]],
		["thinking-only", [{ type: "thinking", thinking: "Synthetic reasoning only." }]],
		["provider envelope", [{ type: "text", text: '{"error":{"message":"Synthetic upstream error","code":503}}' }]],
	] as const) test(`${mode}: ${name} side terminal is journaled as failed`, async t => {
		t.mock.method(settlementRetry, "wait", async () => {});
		const f = fixture(mode, structuredClone(content) as unknown[]);
		try {
			await f.engine.performTurn("Continue synthetic story.");
			const rows = f.rows().filter(row => row.model === "scribe");
			assert.ok(rows.length > 0);
			for (const row of rows) {
				assert.equal(row.status, "failed");
				assert.equal(row.failure?.kind, name === "provider envelope" ? "transport" : "format");
				assert.deepEqual(row.usage, { input: 7, output: 3 });
			}
			const authors = f.sm.getBranch().filter((entry: any) => entry.message?.details?.rpAuthorDraft);
			assert.equal(authors.length, 1, "side failure must not replay or remove the saved author draft");
			if (mode === "director") {
				const tools = f.rows().filter(row => row.model === "writer" && row.stopReason === "toolUse");
				assert.ok(tools.length > 0);
				assert.ok(tools.every(row => row.status === "success"), "valid tool-only author terminals remain successful");
			}
		} finally { f.cleanup(); }
	});
}

test("side SDK options use the current configured analysis deadline", async () => {
	const f = fixture("direct");
	try {
		for (const minutes of [2, 7]) {
			const path = join(f.cwd, "liyuan.config.json");
			const config = JSON.parse(readFileSync(path, "utf8"));
			writeFileSync(path, JSON.stringify({ ...config, analysisTimeoutMinutes: minutes }));
			const start = f.calls.length;
			await f.engine.performTurn("Continue synthetic story.");
			const calls = f.calls.slice(start).filter(call => call.model === "scribe" || call.model === "literaryDirector");
			assert.deepEqual(calls.map(call => call.model).sort(), ["literaryDirector", "scribe"]);
			for (const call of calls) {
				assert.equal(call.options.timeoutMs, minutes * 60_000);
				assert.equal(call.options.maxRetries, 0);
				assert.ok(call.options.signal instanceof AbortSignal);
			}
			assert.ok(f.rows().filter(row => row.model === "scribe").every(row => row.status === "success"));
		}
	} finally { f.cleanup(); }
});
