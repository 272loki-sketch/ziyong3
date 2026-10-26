import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemblePresetAfter, constantLoreOf, loadStageMaterials, projectStageDatabaseWorldbook, projectStageWorldbookEntries, stageDatabaseWorldbookEntries } from "../src/stage/materials.ts";
import { buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { databasePluginWorldbookParts, insertDatabasePluginDepthEntries, selectDatabasePluginWorldbookEntries } from "../src/stage/database-plugin-prompt.ts";

test("native source projection preserves raw placement and bytes instead of constant packaging", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-native-placement-"));
	try {
		const rows = [
			{ id: 1, content: "DEPTH\r\nEXACT", constant: true, position: "before_char", extensions: { position: 4, depth: 999, role: 0 }, insertion_order: 20 },
			{ id: 2, content: "BEFORE", constant: true, position: "before_char", insertion_order: 30 },
			{ id: 3, content: "AFTER", constant: true, extensions: { position: 1 }, insertion_order: 10 },
			{ id: 4, content: "OFF", constant: true, enabled: false, extensions: { position: 4, depth: 0 } },
			{ id: 5, content: "KEYWORD", keys: ["native-trigger"], extensions: { position: 4, depth: 0, role: 1, prevent_recursion: true } },
			{ id: 6, content: "FILTERED", constant: true },
		];
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "Synthetic", description: "CARD", character_book: { entries: rows } } }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", preset: "preset.json" }));
		for (const tailSlots of [false, true]) {
			const ids = tailSlots ? ["start", "charDescription", "chatHistory", "worldInfoBefore", "worldInfoAfter", "end"]
				: ["start", "worldInfoAfter", "charDescription", "worldInfoBefore", "end", "chatHistory"];
			writeFileSync(join(cwd, "preset.json"), JSON.stringify({ prompts: ids.map(identifier => ({ identifier, content: identifier === "start" ? "PRESET_START" : identifier === "end" ? "PRESET_END" : "", marker: !["start", "end"].includes(identifier) })), prompt_order: [{ character_id: 100001, order: ids.map(identifier => ({ identifier, enabled: true })) }] }));
			const loaded = loadStageMaterials(cwd, { nativeTavernPlugins: true });
			const filtered = projectStageWorldbookEntries(loaded, loaded.entries.flatMap((entry, i) => entry.uid === 6 ? [] : [i]));
			const native = stageDatabaseWorldbookEntries(filtered);
			assert.equal(native[0].position, 4);
			assert.equal(native[0].depth, 999);
			assert.equal(native[0].role, 0);
			assert.equal(native[0].content, rows[0].content);
			assert.equal(native[4].prevent_recursion, true);
			const parts = databasePluginWorldbookParts(selectDatabasePluginWorldbookEntries(native, [], "native-trigger"));
			const projected = projectStageDatabaseWorldbook(filtered, parts);
			assert.deepEqual(constantLoreOf(projected), []);
			assert.equal(constantLoreOf(filtered).length, 3, "the non-database material view is unchanged");
			const system = buildStageSystemPrompt({ card: projected.card, config: projected.config, constantLore: constantLoreOf(projected), presetBefore: projected.presetBefore.map(piece => piece.text), declaredMarkers: projected.declaredMarkers, generationMode: "direct" });
			const tail = (assemblePresetAfter(projected, "native-trigger") ?? []).map(piece => piece.text).join("\n\n");
			const messages = insertDatabasePluginDepthEntries([{ role: "user", content: [{ type: "text", text: tail + "\nINPUT" }] }], parts.depthEntries) as any[];
			assert.deepEqual(messages.map(message => message.role), ["system", "user", "user"]);
			assert.equal(messages[0].content[0].text, rows[0].content);
			assert.equal(messages[2].content[0].text, "KEYWORD");
			assert.ok(!system.includes("DEPTH") && !tail.includes("DEPTH"));
			const delivered = system + tail + messages[0].content[0].text + messages[2].content[0].text;
			for (const content of ["BEFORE", "AFTER", "PRESET_START", "PRESET_END", "KEYWORD"]) assert.equal(delivered.split(content).length - 1, 1);
			assert.doesNotMatch(delivered, /OFF|FILTERED/);
			assert.deepEqual(projected.presetBefore.filter(piece => piece.source === "block"), filtered.presetBefore.filter(piece => piece.source === "block"));
			if (!tailSlots) assert.ok(system.indexOf("AFTER") < system.indexOf("CARD") && system.indexOf("CARD") < system.indexOf("BEFORE"), "preset marker order remains authoritative");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
