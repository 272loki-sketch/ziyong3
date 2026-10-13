import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabasePluginHttp } from "../server/database-plugin-http.ts";
import { DatabasePluginStore } from "../server/database-plugin-store.ts";
import { DatabasePluginRuntime } from "../server/database-plugin-runtime.ts";

// Characterization tests, not acceptance tests for detached settlement.
const state = (label: string) => ({ messages: {}, chatMetadata: { label }, extensionSettings: {}, worldbooks: {} });

test("detachment blocker: ancestor whole-snapshot publication hides descendant preflight state", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-detachment-safety-"));
 try {
  const store = new DatabasePluginStore(cwd), scope = { sessionId: "synthetic", card: "synthetic.json" };
  await store.saveState(scope, "A", 0, state("A baseline"));
  await store.saveState(scope, "B", 1, state("B durable preflight"));
  await assert.rejects(store.saveState(scope, "A", 1, state("A after")), /revision conflict/i);
  // Retrying with the latest revision does not merge the descendant's changes.
  await store.saveState(scope, "A", 2, state("A after"));
  const view = await store.readState(scope, ["A", "B"]);
  assert.equal(view.snapshot?.state.chatMetadata.label, "A after");
  assert.equal(view.snapshot?.sourceEntryId, "A");
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("detachment blocker: global background source binding also changes management context", async () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-detachment-safety-"));
 try {
  const current = { scope: { sessionId: "synthetic" }, sourceEntryId: "B", visibleEntryIds: ["A", "B"],
   chat: [{ __liyuanEntryId: "A" }, { __liyuanEntryId: "B" }], character: {}, userName: "Synthetic" };
  const http = new DatabasePluginHttp(cwd, { context: () => current, isStreaming: () => false, generate: async () => "" });
  const binding = { scopeKey: http.scopeKey(current), sourceEntryId: "B" };
  http.assertBinding(binding);
  http.boundSourceEntryId = "A";
  assert.equal(http.currentContext().sourceEntryId, "A");
  assert.throws(() => http.assertBinding(binding), /拒绝迟到/);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("detachment blocker: runtime before cannot start while after is gated", async () => {
 let release!: () => void, started!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const entered = new Promise<void>(resolve => { started = resolve; });
 const http = { assertBinding() {}, boundSourceEntryId: undefined } as any;
 const runtime = new DatabasePluginRuntime(http, () => "http://synthetic.invalid");
 let evaluations = 0;
 (runtime as any).ensure = async () => ({ evaluate: async () => {
  evaluations++;
  if (evaluations === 1) { started(); await gate; }
  return { sourceEntryId: "B", userInput: "Synthetic", errors: [] };
 } });
 const after = runtime.after("A");
 await entered;
 const before = runtime.before("Synthetic");
 try {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(evaluations, 1, "removing engine await alone still blocks the next before");
 } finally { release(); await Promise.all([after, before]); }
 assert.equal(evaluations, 2);
});
