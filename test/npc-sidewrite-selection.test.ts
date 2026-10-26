import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NPC_SIDEWRITE_SETTINGS, parseSidewriteOutput, pickSidewriteTargets } from "../src/stage/npc-sidewrite.ts";

test("zero cooldown really disables the history penalty while positive windows remain bounded", () => {
	const roster = ["Alpha", "Beta"].map(name => ({ name, notes: "", weight: 1 }));
	const settings = { ...DEFAULT_NPC_SIDEWRITE_SETTINGS, maxPerRound: 1, cooldownRounds: 0 };
	assert.deepEqual(pickSidewriteTargets(roster, settings, [["Alpha"]], undefined, () => 0.4), ["Alpha"]);
	assert.deepEqual(pickSidewriteTargets(roster, { ...settings, cooldownRounds: 1 }, [["Alpha"]], undefined, () => 0.4), ["Beta"]);
	assert.deepEqual(pickSidewriteTargets(roster, { ...settings, cooldownRounds: 1 }, [["Alpha"], ["Beta"]], undefined, () => 0.4), ["Alpha"]);
});

test("NPC output cannot turn a partial or decorated name into a different roster identity", () => {
	const names = ["Alex", "Alexandra", "Morgan Lee", "Morgan Lane"];
	const output = parseSidewriteOutput([
		"<npc:Morgan>ambiguous</npc:Morgan>",
		"<npc:Alexandra's friend>not Alexandra</npc:Alexandra's friend>",
		"<npc: alex >exact name with harmless casing</npc:alex>",
		"<npc:Morgan Lane>the correct person</npc:Morgan Lane>",
	].join("\n"), names);
	assert.deepEqual([...output.keys()], ["Alex", "Morgan Lane"]);
	assert.equal(output.get("Morgan Lane")?.text, "the correct person");
	assert.equal(parseSidewriteOutput("<npc:alex>ambiguous case collision</npc:alex>", ["Alex", "ALEX"]).size, 0);
});
