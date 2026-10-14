import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryScopeRoot } from "../src/memory/config.ts";
import { closeMemoryDatabase, clearStore, loadChunks, persistChunks } from "../src/memory/store.ts";

const scope = {sessionId: "synthetic-lifecycle", card: "synthetic-card.json"};
const row = {id:"synthetic-row", text:"Synthetic lifecycle data.", embedding:[1,0], meta:{source:"manual" as const}, createdAt:"2026-01-01T00:00:00.000Z"};

test("memory owner can close, move its directory and reopen without losing persisted rows", () => {
 const parent = mkdtempSync(join(tmpdir(), "liyuan-memory-close-"));
 const root = join(parent, "owner"), moved = join(parent, "moved");
 mkdirSync(root);
 try {
  persistChunks(root, scope, "external", [row]);
  assert.equal(closeMemoryDatabase(root), true);
  assert.equal(closeMemoryDatabase(root), false, "idempotent release");
  assert.ok(existsSync(join(root, ".liyuan-memory", "memory.sqlite")));
  renameSync(root, moved);
  assert.deepEqual(loadChunks(moved, scope, "external"), [row]);
  closeMemoryDatabase(moved);
  renameSync(moved, root);
  assert.deepEqual(loadChunks(root, scope, "external"), [row]);
 } finally { closeMemoryDatabase(root); closeMemoryDatabase(moved); rmSync(parent,{recursive:true,force:true}); }
});

test("closing one owner does not close another owner or remigrate cleared legacy data", () => {
 const parent = mkdtempSync(join(tmpdir(), "liyuan-memory-close-isolation-"));
 const first=join(parent,"first"), second=join(parent,"second");
 mkdirSync(first);mkdirSync(second);
 try {
  const legacy=join(memoryScopeRoot(first,scope),"stores","external");
  mkdirSync(legacy,{recursive:true});writeFileSync(join(legacy,"chunks.jsonl"),JSON.stringify(row)+"\n");
  assert.deepEqual(loadChunks(first,scope,"external"),[row]);
  clearStore(first,scope,"external");persistChunks(second,scope,"external",[row]);
  assert.equal(closeMemoryDatabase(first),true);
  assert.deepEqual(loadChunks(first,scope,"external"),[],"release does not resurrect cleared legacy files");
  assert.deepEqual(loadChunks(second,scope,"external"),[row]);
  assert.equal(closeMemoryDatabase(second),true,"unrelated cached handle was still owned");
 } finally { closeMemoryDatabase(first);closeMemoryDatabase(second);rmSync(parent,{recursive:true,force:true}); }
});
