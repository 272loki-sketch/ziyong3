import assert from "node:assert/strict";
import test from "node:test";
import { DatabasePluginRuntime } from "../server/database-plugin-runtime.ts";

test("database observation labels follow runtime boundaries, and always clear on failure", async () => {
 const http = { assertBinding() {}, boundSourceEntryId: undefined } as any;
 const runtime = new DatabasePluginRuntime(http, () => "http://synthetic.invalid");
 const phases: unknown[] = [];
 let fail = false;
 (runtime as any).ensure = async () => ({ evaluate: async () => {
  phases.push([runtime.requestPhase, http.boundSourceEntryId]);
  if (fail) throw new Error("synthetic failure");
  return { sourceEntryId: "user", userInput: "synthetic", errors: [] };
 } });
 await runtime.before("synthetic");
 assert.equal(runtime.requestPhase, undefined);
 await runtime.after("reply");
 assert.equal(runtime.requestPhase, undefined);
 assert.equal(http.boundSourceEntryId, undefined);
 assert.deepEqual(phases, [["database.before", undefined], ["database.after", "reply"]]);
 fail = true;
 await assert.rejects(runtime.before("synthetic"), /synthetic failure/);
 assert.equal(runtime.requestPhase, undefined);
 await assert.rejects(runtime.after("reply"), /synthetic failure/);
 assert.equal(runtime.requestPhase, undefined);
 assert.equal(http.boundSourceEntryId, undefined);
});
