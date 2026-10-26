import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureNovelPlayLorebook } from "../src/novel-play/application.ts";
import { resolveWorldbooks, scopedLorebookPaths } from "../src/worldbook-bindings.ts";
import type { RpConfig } from "../src/types.ts";

test("generated novel profiles stay card-local and different package revisions do not overwrite each other", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-novel-lorebook-scope-"));
	try {
		mkdirSync(join(cwd, "assets/cards"), { recursive: true });
		mkdirSync(join(cwd, "assets/lorebooks"), { recursive: true });
		const card = (name: string, revision?: string) => ({ spec: "chara_card_v2", spec_version: "2.0", data: {
			name, description: "", personality: "", scenario: "", first_mes: "", mes_example: "",
			extensions: revision ? { liyuanNovelPlay: { docId: "same-book", revision, anchorKind: "source-end" } } : {},
			character_book: { entries: revision ? [{ id: 120, keys: [name], content: `profile-${revision}`, enabled: true, selective: true, insertion_order: 120 }] : [] },
		} });
		writeFileSync(join(cwd, "assets/cards/one.json"), JSON.stringify(card("one", "revision-one")));
		writeFileSync(join(cwd, "assets/cards/two.json"), JSON.stringify(card("two", "revision-two")));
		writeFileSync(join(cwd, "assets/cards/ordinary.json"), JSON.stringify(card("ordinary")));
		writeFileSync(join(cwd, "assets/lorebooks/global.json"), JSON.stringify({ entries: [] }));
		writeFileSync(join(cwd, "assets/lorebooks/aux.json"), JSON.stringify({ entries: [] }));
		const configFile = join(cwd, "liyuan.config.json");
		const readConfig = () => JSON.parse(readFileSync(configFile, "utf8")) as RpConfig;
		writeFileSync(configFile, JSON.stringify({ card: "assets/cards/one.json", lorebooks: ["assets/lorebooks/global.json"], lorebookBindings: { character: { "assets/cards/one.json": ["assets/lorebooks/aux.json"] } } }));
		const first = ensureNovelPlayLorebook(cwd)!;
		assert.match(first, /^assets\/lorebooks\/novel-play-[a-f0-9]{64}\.json$/);
		const firstBytes = readFileSync(join(cwd, first), "utf8");
		assert.deepEqual(readConfig().lorebooks, ["assets/lorebooks/global.json"]);
		assert.deepEqual(scopedLorebookPaths(readConfig(), "character_aux"), ["assets/lorebooks/aux.json", first]);
		assert.ok(resolveWorldbooks(cwd, readConfig()).books.some(book => book.path === first && book.scope === "character_aux"));
		assert.equal(ensureNovelPlayLorebook(cwd), first);
		assert.equal(scopedLorebookPaths(readConfig(), "character_aux").length, 2);
		writeFileSync(configFile, JSON.stringify({ ...readConfig(), card: "assets/cards/two.json" }));
		const second = ensureNovelPlayLorebook(cwd)!;
		assert.notEqual(second, first);
		assert.equal(readFileSync(join(cwd, first), "utf8"), firstBytes);
		assert.deepEqual(scopedLorebookPaths(readConfig(), "character_aux"), [second]);
		assert.equal(resolveWorldbooks(cwd, readConfig()).books.some(book => book.path === first), false);
		writeFileSync(configFile, JSON.stringify({ ...readConfig(), card: "assets/cards/ordinary.json" }));
		assert.equal(ensureNovelPlayLorebook(cwd), undefined);
		assert.deepEqual(scopedLorebookPaths(readConfig(), "character_aux"), []);
		assert.equal(resolveWorldbooks(cwd, readConfig()).books.some(book => book.path === first || book.path === second), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
