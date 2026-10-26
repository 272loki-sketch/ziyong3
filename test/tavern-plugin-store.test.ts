/** Public store/validator API regressions. All sessions, branches and files are synthetic and isolated. */
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TavernPluginStore, emptyTavernPluginState, tavernPluginScope, validateTavernPluginState, type TavernPluginBinding, type TavernPluginState } from "../server/tavern-plugin-store.ts";

const MIB = 1024 * 1024;
function binding(sourceEntryId = "root", visibleEntryIds = ["root"]): TavernPluginBinding {
	return { sessionId: "synthetic-store-session", card: "synthetic-card", sourceEntryId, visibleEntryIds };
}
function state(marker: unknown = "root"): TavernPluginState {
	return { ...emptyTavernPluginState(), chatMetadata: { marker } };
}
function save(store: TavernPluginStore, target: TavernPluginBinding, value: TavernPluginState, revision = store.read(target).revision, guard: () => void = () => {}) {
	// Same public validation seam used by the HTTP layer; save itself accepts trusted typed state.
	validateTavernPluginState(value, new Set([...target.visibleEntryIds, target.sourceEntryId]));
	return store.save(target, revision, value, guard);
}
function scopePaths(store: TavernPluginStore, target = binding()) {
	const root = join(store.root, tavernPluginScope(target));
	return { root, objects: join(root, "objects"), index: join(root, "index.json"), backup: join(root, "index.json.bak"), lock: join(root, ".write-lock") };
}
function fixture(run: (data: { cwd: string; store: TavernPluginStore }) => void) {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-store-test-"));
	try { run({ cwd, store: new TavernPluginStore(cwd) }); }
	finally { rmSync(cwd, { recursive: true, force: true }); }
}
function assertPosixMode(path: string, expected: number) {
	if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, expected, path);
}

test("siblings cannot see each other's metadata, message variables or derived worldbooks", () => fixture(({ store }) => {
	const root = binding(), a = binding("a", ["root", "a"]), b = binding("b", ["root", "b"]);
	const initial = state("ancestor"); initial.messages.root = { variables: [{ ancestor: true }] }; save(store, root, initial);
	const branchA = store.read(a).state; branchA.chatMetadata.marker = "only-A"; branchA.messages.a = { variables: [{ privateToA: true }] }; branchA.worldbooks.A = { entries: [{ uid: 1, content: "synthetic A only" }] }; save(store, a, branchA);
	const viewB = store.read(b); assert.equal(viewB.state.chatMetadata.marker, "ancestor"); assert.equal(viewB.state.messages.a, undefined); assert.equal(viewB.state.worldbooks.A, undefined);
	const branchB = viewB.state; branchB.chatMetadata.marker = "only-B"; branchB.messages.b = { variables: [{ privateToB: true }] }; save(store, b, branchB);
	assert.equal(store.read(a).state.chatMetadata.marker, "only-A"); assert.equal(store.read(a).state.messages.b, undefined); assert.equal(store.read(root).state.chatMetadata.marker, "ancestor");
}));

test("unwritten descendant inherits all ancestor-derived extension fields", () => fixture(({ store }) => {
	const initial = state("ancestor"); initial.extensionSettings = { fixturePlugin: { enabled: true } }; initial.characterExtensions = { fixtureCharacter: 12 }; initial.presetExtensions = { fixturePreset: 17 }; initial.messages.root = { variables: [{ inherited: 31 }], extra: { note: "synthetic derived only" } }; initial.worldbooks = { Derived: { entries: [{ uid: 1, content: "synthetic setting" }] } };
	save(store, binding(), initial); const descendant = store.read(binding("descendant", ["root", "descendant"])); assert.deepEqual(descendant.state, initial); assert.equal(descendant.revision, 1);
}));

test("session and card each isolate otherwise identical branch identifiers", () => fixture(({ store }) => {
	save(store, binding(), state("original-scope"));
	for (const target of [{ ...binding(), sessionId: "other-synthetic-session" }, { ...binding(), card: "other-synthetic-card" }]) {
		assert.deepEqual(store.read(target), { revision: 0, state: emptyTavernPluginState() }); save(store, target, state("different-scope"));
	}
	assert.equal(store.read(binding()).state.chatMetadata.marker, "original-scope");
}));

test("global scope CAS rejects stale sibling saves, invalid revisions and a held write lock", () => fixture(({ store }) => {
	save(store, binding(), state("root")); const a = binding("a", ["root", "a"]), b = binding("b", ["root", "b"]), stale = store.read(b).revision;
	save(store, a, state("A")); const paths = scopePaths(store), before = readFileSync(paths.index);
	for (const expected of [stale, -1, NaN, 1.5]) assert.throws(() => save(store, b, state("late-B"), expected), { statusCode: 409 });
	assert.deepEqual(readFileSync(paths.index), before); assert.equal(store.read(b).state.chatMetadata.marker, "root");
	mkdirSync(paths.lock, { mode: 0o700 }); assert.throws(() => save(store, b, state("locked")), { statusCode: 409 }); rmSync(paths.lock, { recursive: true });
}));

test("late branch guard stops index commit and releases the scope lock", () => fixture(({ store }) => {
	save(store, binding(), state("before")); const paths = scopePaths(store), original = readFileSync(paths.index); let calls = 0;
	assert.throws(() => save(store, binding(), state("late"), 1, () => { if (++calls === 2) throw Object.assign(new Error("synthetic changed branch"), { statusCode: 409 }); }), { statusCode: 409 });
	assert.equal(calls, 2); assert.deepEqual(readFileSync(paths.index), original); assert.equal(store.read(binding()).state.chatMetadata.marker, "before"); assert.equal(existsSync(paths.lock), false);
}));

for (const field of ["mes", "text", "thinking", "rpNarrative", "rpAuthorDraft", "rpTimeline", "unexpected"]) {
	test(`validator rejects message story/unknown field ${field}`, () => fixture(({ store }) => {
		const invalid = state(); invalid.messages.root = { [field]: "never canonical story" } as never;
		assert.throws(() => validateTavernPluginState(invalid, new Set(["root"])), /不得修改正文/); assert.deepEqual(store.read(binding()).state, emptyTavernPluginState());
	}));
}

test("validator rejects unknown state fields and non-ancestor message writes", () => fixture(({ store }) => {
	assert.throws(() => validateTavernPluginState({ ...state(), unknown: {} }, new Set(["root"])), /未知插件状态字段/);
	const sibling = state(); sibling.messages.sibling = { variables: [{ bad: true }] }; assert.throws(() => validateTavernPluginState(sibling, new Set(["root", "current"])), { statusCode: 409 });
	assert.deepEqual(store.read(binding()).state, emptyTavernPluginState());
}));

test("validator rejects canonical fields inside message extra, prototype fields and non-JSON values", () => {
	for (const field of ["mes", "text", "thinking", "rpNarrative", "rpAuthorDraft", "rpTimeline"]) {
		const invalid = state(); invalid.messages.root = { extra: { [field]: "not authoritative" } }; assert.throws(() => validateTavernPluginState(invalid, new Set(["root"])), /冒充故事正文/);
	}
	const prototype = JSON.parse(JSON.stringify(state()).replace('"marker":"root"', '"__proto__":{"fixture":true}'));
	assert.throws(() => validateTavernPluginState(prototype, new Set(["root"])), /原型字段/);
	for (const value of [NaN, Infinity, new Date(0), () => "fixture"]) assert.throws(() => validateTavernPluginState(state(value), new Set(["root"])), /普通 JSON/);
});

test("readonly card/mounted worldbooks cannot be written, derived books remain writable", () => fixture(({ store }) => {
	const value = state(); value.worldbooks.Readonly = { entries: [{ uid: 1, content: "synthetic forbidden edit" }] };
	assert.throws(() => validateTavernPluginState(value, new Set(["root"]), new Set(["Readonly"])), /世界书只读/);
	delete value.worldbooks.Readonly; value.worldbooks.Derived = { entries: [{ uid: 2, content: "synthetic derived setting" }] }; save(store, binding(), value);
	assert.deepEqual(store.read(binding()).state.worldbooks, value.worldbooks);
}));

for (const target of ["parent", "state", "scope", "objects"] as const) {
	test(`ordinary private directory enforcement rejects ${target} symlink`, () => {
		const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-store-link-")), outside = join(cwd, "outside"); mkdirSync(outside, { mode: 0o755 }); writeFileSync(join(outside, "sentinel"), "synthetic sentinel"); const mode = statSync(outside).mode;
		try {
			if (target === "parent" || target === "state") {
				const parent = join(cwd, ".liyuan-tavern-plugins"); if (target === "state") mkdirSync(parent);
				symlinkSync(outside, target === "parent" ? parent : join(parent, "state"), "dir"); assert.throws(() => new TavernPluginStore(cwd), /真实目录/);
			} else {
				const store = new TavernPluginStore(cwd); store.read(binding()); const paths = scopePaths(store), path = target === "scope" ? paths.root : paths.objects;
				rmSync(path, { recursive: true }); symlinkSync(outside, path, "dir"); assert.throws(() => store.read(binding()), /真实目录/);
			}
			assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "synthetic sentinel"); assert.equal(statSync(outside).mode, mode);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("final index and content-addressed object symlinks are refused even when bytes match", () => fixture(({ cwd, store }) => {
	const value = state("distinct-synthetic-metadata"); save(store, binding(), value); const paths = scopePaths(store);
	const metadata = JSON.stringify(value.chatMetadata); const file = readdirSync(paths.objects).find(name => readFileSync(join(paths.objects, name), "utf8").trim() === metadata); assert.ok(file);
	const object = join(paths.objects, file), originalObjectBytes = readFileSync(object), outsideObject = join(cwd, "outside-object.json"); writeFileSync(outsideObject, originalObjectBytes); unlinkSync(object); symlinkSync(outsideObject, object);
	assert.throws(() => store.read(binding()), /文件类型或大小/); unlinkSync(object); writeFileSync(object, originalObjectBytes, { mode: 0o600 });
	const original = readFileSync(paths.index), outsideIndex = join(cwd, "outside-index.json"); writeFileSync(outsideIndex, original); unlinkSync(paths.index); symlinkSync(outsideIndex, paths.index);
	assert.throws(() => store.read(binding()), /文件类型或大小/); assert.throws(() => save(store, binding(), value, 1), /文件类型或大小/); assert.deepEqual(readFileSync(outsideIndex), original);
}));

test("parent replaced by a symlink after constructor is rejected before reading outside state", () => fixture(({ cwd, store }) => {
	save(store, binding(), state("inside-only")); const parent = join(cwd, ".liyuan-tavern-plugins"), outside = join(cwd, "outside-copy"); cpSync(parent, outside, { recursive: true }); renameSync(parent, `${parent}.old`); symlinkSync(outside, parent, "dir");
	assert.throws(() => store.read(binding()), /真实目录/); assert.throws(() => store.save(binding(), 1, state("never outside"), () => {}), /真实目录/);
}));

test("repeated same-source writes do not append unbounded index or blob history", () => fixture(({ store }) => {
	for (let i = 0; i < 80; i++) save(store, binding(), state(i));
	const paths = scopePaths(store); assert.equal(store.read(binding()).revision, 80); assert.equal(store.read(binding()).state.chatMetadata.marker, 79);
	assert.ok(statSync(paths.index).size < 2048, "same-source index must remain bounded independently of its wire schema"); assert.ok(readdirSync(paths.objects).length < 20, "retain current and actual backup references, not all discarded revisions");
}));

test("derived-book deletion is inherited as a tombstone but does not erase sibling/ancestor books", () => fixture(({ store }) => {
	const root = state(); root.worldbooks.Derived = { entries: [{ uid: 1, content: "synthetic inherited book" }] }; save(store, binding(), root);
	const a = binding("a", ["root", "a"]), deleted = store.read(a).state; delete deleted.worldbooks.Derived; save(store, a, deleted);
	assert.deepEqual(store.read(a).state.worldbooks, {}); assert.deepEqual(store.read(binding("grandchild", ["root", "a", "grandchild"])).state.worldbooks, {});
	assert.deepEqual(store.read(binding("b", ["root", "b"])).state.worldbooks, root.worldbooks); assert.deepEqual(store.read(binding()).state.worldbooks, root.worldbooks);
}));

test("existing child retains old immutable ancestor snapshot; new child inherits edited ancestor", () => fixture(({ store }) => {
	const root = binding(), a = binding("a", ["root", "a"]); save(store, root, state(1));
	const inherited = store.read(a).state; assert.equal(inherited.chatMetadata.marker, 1); save(store, a, inherited);
	save(store, root, state(2)); assert.equal(store.read(a).state.chatMetadata.marker, 1, "ancestor edit must not flow back into an already committed child snapshot");
	const b = binding("b", ["root", "b"]); assert.equal(store.read(b).state.chatMetadata.marker, 2); save(store, b, store.read(b).state);
	for (let value = 3; value < 7; value++) save(store, root, state(value));
	assert.equal(store.read(a).state.chatMetadata.marker, 1); assert.equal(store.read(b).state.chatMetadata.marker, 2); assert.equal(store.read(root).state.chatMetadata.marker, 6);
}));

test("atomic index.bak retains every object needed to read that actual previous state", () => fixture(({ store }) => {
	save(store, binding(), state("first")); save(store, binding(), state("second")); const paths = scopePaths(store), backup = readFileSync(paths.backup);
	assertPosixMode(paths.index, 0o600); assertPosixMode(paths.backup, 0o600);
	// Restore only the actual .bak from this isolated fixture, without depending on v2/v3 index internals.
	writeFileSync(paths.index, backup); assert.equal(store.read(binding()).state.chatMetadata.marker, "first"); assert.equal(store.read(binding()).revision, 1);
}));

test("validator enforces 32MiB serialized-state budget and accepts a bounded near-limit fixture", () => {
	assert.throws(() => validateTavernPluginState(state("x".repeat(32 * MIB)), new Set(["root"])), /32MiB/);
	assert.doesNotThrow(() => validateTavernPluginState(state("x".repeat(32 * MIB - 1024)), new Set(["root"])));
});

test("oversized candidate index is rejected with EDQUOT without truncating active/backup state", () => fixture(({ store }) => {
	save(store, binding(), state("older")); save(store, binding(), state("before")); const paths = scopePaths(store), original = readFileSync(paths.index), backup = readFileSync(paths.backup);
	// A deliberately huge synthetic source identifier crosses the candidate-index budget through public API only.
	const huge = binding(`synthetic-source-${"x".repeat(4 * MIB)}`, ["root"]);
	assert.throws(() => save(store, huge, state("never committed")), { code: "EDQUOT" }); assert.deepEqual(readFileSync(paths.index), original); assert.equal(store.read(binding()).state.chatMetadata.marker, "before"); assert.deepEqual(readFileSync(paths.backup), backup); assert.equal(existsSync(paths.lock), false);
}));

test("over-4MiB stored index is rejected before parsing or modifying it", () => fixture(({ store }) => {
	save(store, binding(), state()); const paths = scopePaths(store), initial = readFileSync(paths.index); const oversized = Buffer.concat([initial, Buffer.alloc(4 * MIB + 1 - initial.length, 32)]); writeFileSync(paths.index, oversized);
	assert.throws(() => store.read(binding()), /文件类型或大小/); assert.throws(() => save(store, binding(), state("never committed"), 1), /文件类型或大小/); assert.deepEqual(readFileSync(paths.index), oversized); assert.equal(existsSync(paths.lock), false);
}));


test("store public save API itself rejects canonical, unknown and non-ancestor state", () => fixture(({ store }) => {
	const canon = state(); canon.messages.root = { text: "must not become story" } as never; assert.throws(() => store.save(binding(), 0, canon, () => {}), /不得修改正文/);
	const foreign = state(); foreign.messages.sibling = { variables: { fixture: true } }; assert.throws(() => store.save(binding(), 0, foreign, () => {}), { statusCode: 409 });
	assert.throws(() => store.save(binding(), 0, { ...state(), unknown: true } as never, () => {}), /未知插件状态字段/); assert.deepEqual(store.read(binding()).state, emptyTavernPluginState());
}));

test("terminal backup symlink prevents commit without modifying outside bytes or current revision", () => fixture(({ cwd, store }) => {
	save(store, binding(), state("first")); save(store, binding(), state("current")); const paths = scopePaths(store), current = readFileSync(paths.index), backup = readFileSync(paths.backup), outside = join(cwd, "outside-backup.json");
	writeFileSync(outside, backup); unlinkSync(paths.backup); symlinkSync(outside, paths.backup); assert.throws(() => save(store, binding(), state("not committed")), /文件类型或大小/); assert.deepEqual(readFileSync(paths.index), current); assert.deepEqual(readFileSync(outside), backup); assert.equal(store.read(binding()).revision, 2); assert.equal(existsSync(paths.lock), false);
}));

test('legacy source counts above eight remain usable and are not reset on reopen',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-unlimited-count-'));
 try{
  const store=new TavernPluginStore(cwd),scope={sessionId:'synthetic',card:'synthetic',sourceEntryId:'story',visibleEntryIds:['story']};
  for(let i=0;i<19;i++)assert.equal(store.recordModelRequest(scope,()=>{}).calls,i+1);
  const reopened=new TavernPluginStore(cwd);assert.deepEqual(reopened.modelRequestUsage(scope),{used:19,unlimited:true});
  assert.equal(reopened.claimModelRequest(scope,8,()=>{}).calls,20);assert.deepEqual(reopened.modelRequestBudget(scope,8),{limit:null,used:20,remaining:null,unlimited:true});
  assert.throws(()=>reopened.recordModelRequest(scope,()=>{throw Error('stale source')}),/stale source/);assert.equal(reopened.modelRequestUsage(scope).used,20);
 }finally{rmSync(cwd,{recursive:true,force:true})}
});
