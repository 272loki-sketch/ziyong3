import assert from "node:assert/strict";
import test from "node:test";
import { defaultLiteraryEcologyState, ecologyWireView, literaryEcologyFromBranch, normalizeLiteraryEcologyState } from "../src/stage/literary-ecology.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

test("ecology dossier separates terminal history without truncating current public events", () => {
	const state = normalizeLiteraryEcologyState({ occurrences: [
		...Array.from({ length: 3 }, (_, i) => ({ id: `old-${i}`, name: `Day one ${i}`, patternKey: `old-${i}`, visibility: "public", status: i === 2 ? "expired" : "resolved" })),
		...Array.from({ length: 5 }, (_, i) => ({ id: `new-${i}`, name: `Day seven ${i}`, patternKey: `new-${i}`, visibility: "public", status: i === 4 ? "scheduled" : "active" })),
		{ id: "secret", name: "Hidden", patternKey: "secret", visibility: "secret" },
		{ id: "discoverable", name: "Later discovery", patternKey: "discoverable", visibility: "discoverable", status: "active" },
	] }, defaultLiteraryEcologyState())!;
	const before = JSON.stringify(state), view = ecologyWireView(state);
	assert.equal(view.public.events.length, 5);
	assert.equal(view.public.historyEvents?.length, 3);
	assert.ok(view.public.events.every(row => row.startsWith("Day seven")));
	assert.equal(view.discovered.events.length, 1);
	assert.match(view.discovered.events[0], /Later discovery/);
	assert.equal(JSON.stringify(state), before);
});

test("ecology dossier distinguishes old, failed, unfinished and current source-bound snapshots", () => {
	const saved = { type: "custom", id: "eco-old", customType: "rp-ecology-state", data: { ...defaultLiteraryEcologyState(), round: 1, _diagnosticSourceEntryId: "day-one" } };
	const latest = { type: "message", id: "day-seven", message: { role: "assistant", details: { rpNarrative: "Synthetic week later" } } };
	const branch: BranchEntryLike[] = [saved, latest];
	const view = () => ecologyWireView(literaryEcologyFromBranch(branch), branch);
	assert.equal(view().snapshot?.status, "stale");
	branch.push({ customType: "rp-ecology-audit", data: { narrativeEntryId: "day-seven", status: "failed", error: "Synthetic timeout" } });
	assert.equal(view().snapshot?.status, "failed");
	branch.push({ customType: "rp-turn-settlement", data: { narrativeEntryId: "day-seven", status: "pending", ecologyDone: false } });
	assert.equal(view().snapshot?.status, "failed");
	branch.push({ customType: "rp-turn-settlement", data: { narrativeEntryId: "day-seven", status: "settling", ecologyDone: false } });
	assert.equal(view().snapshot?.status, "pending");
	const reloadedBranch = JSON.parse(JSON.stringify(branch)) as BranchEntryLike[];
	assert.equal(ecologyWireView(literaryEcologyFromBranch(reloadedBranch), reloadedBranch).snapshot?.status, "pending", "persisted settling after cancellation/restart means unfinished, not running");
	assert.equal(view().snapshot?.sourceEntryId, "day-one");
	assert.equal(view().snapshot?.entryId, "eco-old");
	branch.push({ ...saved, id: "eco-new", data: { ...saved.data, round: 2, _diagnosticSourceEntryId: "day-seven" } });
	branch.push({ customType: "rp-turn-settlement", data: { narrativeEntryId: "day-seven", status: "complete", ecologyDone: true } });
	assert.equal(view().snapshot?.status, "current");
	assert.equal(view().snapshot?.sourceEntryId, "day-seven");
	assert.equal(ecologyWireView(defaultLiteraryEcologyState(), []).snapshot?.status, "unknown");
	branch.push({ customType: "rp-ecology-audit", data: { narrativeEntryId: "other-branch", status: "failed" } });
	assert.equal(view().snapshot?.status, "current", "unrelated source failures must not taint this snapshot");
});

test("branch reading and wire preserve persisted degradation without promoting it to current", () => {
	const degraded = { stage: "aftermath" as const, error: "Synthetic timeout" };
	const branch: BranchEntryLike[] = [{ type: "custom", customType: "rp-ecology-state", data: { ...defaultLiteraryEcologyState(), round: 2, degraded } }];
	const state = literaryEcologyFromBranch(branch);
	assert.deepEqual(state.degraded, degraded);
	const view = ecologyWireView(state, branch);
	assert.deepEqual(view.degraded, degraded);
	assert.equal(view.snapshot?.status, "failed");
});
