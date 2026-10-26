import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { novelNodeId, type NovelSource } from "../src/novel-play/source.ts";
import { MAX_NOVEL_CALIBRATION_CANDIDATE_CHARS, NOVEL_PLAY_UPGRADE_ENTRY_TYPE, commitNovelPlayState, effectiveNovelPlayBinding, novelPlayStateFromBranch, prepareNovelPlayTurn } from "../src/novel-play/runtime.ts";
import { apply as applyEnginePatch } from "../scripts/novel-integration/engine-patch.mjs";

const sourceText = "Alpha Beta Gamma Delta Epsilon";
const source: NovelSource = { version: 1, docId: "book", title: "Book", fingerprint: "fp", chunkChars: 100, chunks: [{ index: 0, chars: sourceText.length, chapters: ["c"], text: sourceText }] };
const ref = (start: number, end: number) => ({ chunkIndex: 0, start, end, quote: sourceText.slice(start, end) });
const a = novelNodeId(source, ref(0, 5), "a"), b = novelNodeId(source, ref(6, 10), "b"), secret = novelNodeId(source, ref(11, 16), "secret"), d = novelNodeId(source, ref(17, 22), "d"), e = novelNodeId(source, ref(23, 30), "e");
const pkg = buildNovelPackage(source, [{ id: "s1", order: 0, title: "Stage 1" }, { id: "s2", order: 1, title: "Stage 2" }, { id: "s3", order: 2, title: "Stage 3" }], [
	{ id: a, key: "a", stageId: "s1", order: 0, title: "A", summary: "A happens", visibility: "public", dependsOn: [], sourceRefs: [ref(0, 5)] },
	{ id: b, key: "b", stageId: "s1", order: 1, title: "B", summary: "B happens", visibility: "public", dependsOn: [a], sourceRefs: [ref(6, 10)] },
	{ id: secret, key: "secret", stageId: "s2", order: 2, title: "Secret", summary: "secret", visibility: "secret", dependsOn: [], sourceRefs: [ref(11, 16)] },
	{ id: d, key: "d", stageId: "s2", order: 3, title: "D", summary: "D happens", visibility: "public", dependsOn: [b], sourceRefs: [ref(17, 22)] },
	{ id: e, key: "e", stageId: "s3", order: 4, title: "E", summary: "E happens", visibility: "public", dependsOn: [d], sourceRefs: [ref(23, 30)] },
]);
const rawCard = { data: { extensions: { liyuanNovelPlay: { docId: "book", revision: pkg.revision, startNodeId: a, position: "before" } } } };
const loadPackage = () => ({ version: 1 as const, source, package: pkg });
const branch = [{ id: "root", type: "custom_message", customType: "rp-greeting", content: "start" }, { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "change it" }] } }];
const prepare = (result: unknown, overrides: Partial<Parameters<typeof prepareNovelPlayTurn>[0]> = {}) => prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch, expectedLeafId: "u1", skillBody: "strict", getLeafId: () => "u1", loadPackage, modelCall: async (_system, user) => { assert.doesNotMatch(user, /Alpha Beta Gamma/); return JSON.stringify(result); }, ...overrides });
const resultAt = (nodeId: string, position: "before" | "after", conflicts: unknown[] = []) => ({ version: 1, progress: { packageRevision: pkg.revision, nodeId, position }, conflicts });

test("current branch facts take precedence and causally block canon candidates", async () => {
	const prepared = await prepare(resultAt(a, "before", [{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["u1"] }]));
	assert.deepEqual(prepared?.projection.candidates, []);
	assert.deepEqual(new Set(prepared?.projection.blockedNodeIds), new Set([a, b, d, e]));
});
test("assistant facts use message.details.rpNarrative instead of decorated content", async () => {
	let input = "";
	const narrativeBranch = [...branch, { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "decorated curtain" }], details: { rpNarrative: "authoritative narrative" } } }];
	await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch: narrativeBranch, expectedLeafId: "a1", skillBody: "strict", getLeafId: () => "a1", loadPackage, modelCall: async (_s, user) => { input = user; return JSON.stringify(resultAt(a, "before")); } });
	assert.match(input, /authoritative narrative/); assert.doesNotMatch(input, /decorated curtain/);
});
test("prior conflicts survive branch fact pruning and merge with new evidence", async () => {
	const prior = await prepare(resultAt(a, "before", [{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["u1"] }]));
	const stateEntry = { id: "state1", type: "custom", customType: "rp-novel-play", data: prior!.state };
	const huge = { id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(39_900) }] } };
	let modelInput = "";
	const prepared = await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch: [...branch, stateEntry, huge], expectedLeafId: "u2", skillBody: "strict", getLeafId: () => "u2", loadPackage, modelCall: async (_s, user) => { modelInput = user; return JSON.stringify(resultAt(a, "before", [{ packageRevision: pkg.revision, nodeId: b, sourceEntryIds: ["u2"] }])); } });
	assert.match(modelInput, /prior_conflicts_permanent_until_resolution_protocol/);
	assert.deepEqual(prepared?.state.conflicts, [
		{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["u1"] },
		{ packageRevision: pkg.revision, nodeId: b, sourceEntryIds: ["u2"] },
	]);
});
test("bounded public lookahead offers the next stage and permits boundary progress", async () => {
	let input = "";
	const prepared = await prepare(resultAt(d, "before"), { modelCall: async (_s, user) => { input = user; return JSON.stringify(resultAt(d, "before")); } });
	const parsed = JSON.parse(input);
	assert.deepEqual(parsed.canonical_candidates_not_facts.map((item: { nodeId: string }) => item.nodeId), [a, b, d]);
	assert.ok(JSON.stringify(parsed.canonical_candidates_not_facts).length <= MAX_NOVEL_CALIBRATION_CANDIDATE_CHARS);
	assert.equal(prepared?.state.progress.nodeId, d);
	assert.doesNotMatch(input, new RegExp(secret)); assert.doesNotMatch(input, new RegExp(e)); assert.doesNotMatch(input, /sourceRefs|sourceText/);
});
test("progress accepts only offered nodes and rejects same-node after-to-before regression", async () => {
	assert.equal(await prepare(resultAt(e, "before")), undefined);
	const prior = await prepare(resultAt(a, "after"));
	const stateEntry = { id: "state", type: "custom", customType: "rp-novel-play", data: prior!.state };
	assert.equal(await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch: [...branch, stateEntry], expectedLeafId: "state", skillBody: "strict", getLeafId: () => "state", loadPackage, modelCall: async () => JSON.stringify(resultAt(a, "before")) }), undefined);
});
test("candidate serialization stops at the hard budget", async () => {
	const oversized = { ...pkg, nodes: pkg.nodes.map(node => node.id === a ? { ...node, summary: "z".repeat(MAX_NOVEL_CALIBRATION_CANDIDATE_CHARS) } : node) };
	assert.equal(await prepare(resultAt(a, "before"), { loadPackage: () => ({ version: 1, source, package: oversized }) }), undefined);
});
test("unavailable, throwing, or mismatched stored package suppresses candidates", async () => {
	assert.equal(await prepare(resultAt(a, "before"), { loadPackage: () => { throw new Error("missing"); } }), undefined);
	assert.equal(await prepare(resultAt(a, "before"), { loadPackage: () => ({ version: 1, source, package: { ...pkg, revision: "wrong" } }) }), undefined);
});
test("cross-save state is accepted only when card, revision and branch evidence match", async () => {
	const prepared = await prepare(resultAt(a, "before"));
	const stateEntry = { id: "state", type: "custom", customType: "rp-novel-play", data: prepared!.state };
	assert.ok(novelPlayStateFromBranch([...branch, stateEntry], prepared!.state.card, pkg));
	assert.equal(novelPlayStateFromBranch([{ ...branch[0]!, id: "other" }, stateEntry], prepared!.state.card, pkg), undefined);
});
test("model failure, secret conflicts, and invalid cross-branch evidence suppress candidates", async () => {
	assert.equal(await prepare({}, { modelCall: async () => undefined }), undefined);
	assert.equal(await prepare(resultAt(a, "before", [{ packageRevision: pkg.revision, nodeId: a, sourceEntryIds: ["other-save"] }])), undefined);
	assert.equal(await prepare(resultAt(a, "before", [{ packageRevision: pkg.revision, nodeId: secret, sourceEntryIds: ["u1"] }])), undefined);
});
test("leaf race guard suppresses preparation and persistence", async () => {
	let leaf = "u1";
	const prepared = await prepare(resultAt(a, "before"), { modelCall: async () => { leaf = "other"; return JSON.stringify(resultAt(a, "before")); }, getLeafId: () => leaf });
	assert.equal(prepared, undefined);
	let writes = 0;
	assert.equal(commitNovelPlayState({ prepared: undefined, expectedLeafId: "u1", getLeafId: () => "other", appendCustomEntry: () => { writes++; return "x"; } }), undefined);
	assert.equal(writes, 0);
});
test("reroll reuses plot adaptation without a second calibration call or state write", async () => {
	let calls = 0;
	const prepared = await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch, expectedLeafId: "u1", skillBody: "strict", getLeafId: () => "u1", loadPackage, modelCall: async () => { calls++; return JSON.stringify(resultAt(a, "before")); } });
	assert.ok(prepared?.projection); assert.equal(calls, 1);
	let writes = 0;
	commitNovelPlayState({ prepared: undefined, expectedLeafId: "assistant-reroll", getLeafId: () => "assistant-reroll", appendCustomEntry: () => { writes++; return "x"; } });
	assert.equal(writes, 0);
});
test("append upgrade is branch-local and projects old progress into the child package", () => {
	const child = { ...pkg, revision: "child-revision", lineage: { parentDocId: "book", parentRevision: pkg.revision, relation: "append-only" as const, inheritedNodeIds: pkg.nodes.map(node => node.id), newNodeIds: [] } };
	const state = { id: "state-before-upgrade", type: "custom", customType: "rp-novel-play", data: { version: 1, card: { docId: "book", revision: pkg.revision, startNodeId: a, position: "before", anchorKind: "node" }, progress: { packageRevision: pkg.revision, nodeId: b, position: "after" }, conflicts: [], preparedFromLeafId: "u1" } };
	const upgrade = { id: "upgrade", type: "custom", customType: NOVEL_PLAY_UPGRADE_ENTRY_TYPE, data: { version: 1, from: { docId: "book", revision: pkg.revision, startNodeId: a, position: "before", anchorKind: "node" }, to: { docId: "book", revision: "child-revision", startNodeId: a, position: "before", anchorKind: "node" }, sourceLeafId: "u1" } };
	const branchEntries = [...branch, state, upgrade];
	const binding = effectiveNovelPlayBinding("/unused", rawCard, branchEntries, () => ({ version: 1, source, package: child }));
	assert.equal(binding?.revision, "child-revision");
	const projected = novelPlayStateFromBranch(branchEntries, binding!, child);
	assert.equal(projected?.progress.nodeId, b);
	assert.equal(projected?.progress.packageRevision, "child-revision");
});
test("post-upgrade progress and conflicts supersede inherited state without leaking sibling state", async () => {
	const child = { ...pkg, revision: "child-revision", lineage: { parentDocId: "book", parentRevision: pkg.revision, relation: "append-only" as const, inheritedNodeIds: pkg.nodes.map(node => node.id), newNodeIds: [] } };
	const from = { docId: "book", revision: pkg.revision, startNodeId: a, position: "before" as const, anchorKind: "node" as const };
	const to = { ...from, revision: child.revision };
	const oldState = { id: "old-state", type: "custom", customType: "rp-novel-play", data: { version: 1, card: from, progress: { packageRevision: pkg.revision, nodeId: b, position: "after" }, conflicts: [], preparedFromLeafId: "u1" } };
	const upgrade = { id: "upgrade", type: "custom", customType: NOVEL_PLAY_UPGRADE_ENTRY_TYPE, data: { version: 1, from, to, sourceLeafId: "u1" } };
	const upgradedBranch = [...branch, oldState, upgrade];
	const conflicts = [{ packageRevision: child.revision, nodeId: e, sourceEntryIds: ["u1"] }];
	const currentState = { id: "child-state", type: "custom", customType: "rp-novel-play", data: { version: 1, card: to, progress: { packageRevision: child.revision, nodeId: d, position: "after" }, conflicts, preparedFromLeafId: "upgrade" } };
	const currentBranch = [...upgradedBranch, currentState];
	assert.deepEqual(novelPlayStateFromBranch(currentBranch, to, child), currentState.data);
	assert.equal(novelPlayStateFromBranch(upgradedBranch, to, child)?.progress.nodeId, b);
	const invalid = { ...currentState, data: { ...currentState.data, preparedFromLeafId: "sibling-only" } };
	assert.equal(novelPlayStateFromBranch([...upgradedBranch, invalid], to, child)?.progress.nodeId, b);
	let startingAnchor: unknown;
	const prepared = await prepareNovelPlayTurn({ cwd: "/unused", rawCard, branch: currentBranch, expectedLeafId: "child-state", getLeafId: () => "child-state", skillBody: "strict", loadPackage: () => ({ version: 1, source, package: child }), modelCall: async (_system, user) => {
		startingAnchor = JSON.parse(user).startingAnchor;
		return JSON.stringify({ version: 1, progress: currentState.data.progress, conflicts: [] });
	} });
	assert.deepEqual(startingAnchor, currentState.data.progress);
	assert.deepEqual(prepared?.state.conflicts, conflicts);
});
test("engine patch applies LF/CRLF legacy input and preserves each newline style", () => {
	const legacyLf = [
		'from "../novel-play/runtime.ts"; // novel-play-runtime-integration-v1',
		"\tsceneConductor?: SceneConductor;",
		"\tnovelProjection?: NovelPlayProjection;",
		"}",
		"\t\tlet novelProjection = rerollPrep?.novelProjection;",
		"\t\tlet preparedNovelPlay: PreparedNovelPlayTurn | undefined;",
		"\t\t\t\t\t...(sceneConductor ? { sceneConductor } : {}),",
		"\t\t\t\t\t...(novelProjection ? { novelProjection } : {}),",
		"\t\t\tif (userText !== null) {",
	].join("\n");
	for (const newline of ["\n", "\r\n"]) {
		const source = legacyLf.replace(/\n/g, newline);
		const patched = applyEnginePatch(source);
		assert.match(patched, /novel-play-runtime-integration-v2/);
		assert.doesNotMatch(patched, /rerollPrep\?\.novelProjection/);
		assert.doesNotMatch(patched, /\.\.\.\(novelProjection \? \{ novelProjection \} : \{\}\)/);
		assert.match(patched, /if \(!aborted && userText !== null\)/);
		if (newline === "\r\n") assert.doesNotMatch(patched, /(?<!\r)\n/);
		else assert.doesNotMatch(patched, /\r\n/);
		assert.equal(applyEnginePatch(patched), patched, "already-patched input stays byte-for-byte unchanged");
	}

	// Also exercise the real source path's existing v2-marker detection. This is
	// a code transform only; it must not add or alter prompt-injection text.
	const engine = readFileSync(new URL("../src/stage/engine.ts", import.meta.url), "utf8");
	for (const newline of ["\n", "\r\n"]) {
		const actual = engine.replace(/\r\n/g, "\n").replace(/\n/g, newline);
		assert.equal(applyEnginePatch(actual), actual);
	}
});
