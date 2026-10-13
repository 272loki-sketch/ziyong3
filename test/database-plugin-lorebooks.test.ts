import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabasePluginReadonlyLorebooks, databasePluginReadonlyEntry } from "../server/database-plugin-lorebooks.ts";
import { loadStageMaterials } from "../src/stage/materials.ts";
import { normalizeEntries, overlayPathFor, loreFingerprint, loreSourceKey } from "../src/lorebook.ts";

test("database readonly transport preserves card recursion guards, secondary keys and placement without mutating raw entries", () => {
 const raw = { id: 7, keys: ["钥匙"], secondary_keys: ["归还"], content: "合成原文\r\n尾标", comment: "合成卡条目", constant: false, enabled: true, insertion_order: 8, selective: true, extensions: { prevent_recursion: true, exclude_recursion: true, delay_until_recursion: 2, position: 4, depth: 3, role: 1, selectiveLogic: 2, customFixture: "keep" } };
 const snapshot = JSON.stringify(raw);
 const entry = databasePluginReadonlyEntry(normalizeEntries([raw])[0], raw);
 assert.equal(entry.prevent_recursion, true); assert.equal(entry.exclude_recursion, true);
 assert.equal(entry.delay_until_recursion, 2); assert.equal(entry.position, 4); assert.equal(entry.depth, 3); assert.equal(entry.role, 1);
 assert.equal(entry.selectiveLogic, 2); assert.deepEqual(entry.keysecondary, ["归还"]); assert.deepEqual(entry.keys_secondary, ["归还"]);
 assert.equal(entry.customFixture, "keep"); assert.equal(entry.content, raw.content); assert.equal(entry.type, "keyword");
 assert.equal(JSON.stringify(raw), snapshot);
});

test("database readonly transport maps ST camelCase guards and honors explicit false and native disabled state", () => {
 const raw = { uid: 2, key: ["桥"], content: "合成设定", constant: true, disable: true, preventRecursion: true, excludeRecursion: true, delayUntilRecursion: 1, scanDepth: 4, caseSensitive: false, matchWholeWords: true, extensions: { prevent_recursion: true } };
 const e = databasePluginReadonlyEntry({ ...normalizeEntries([raw])[0], enabled: false }, { ...raw, prevent_recursion: false });
 assert.equal(e.prevent_recursion, false); assert.equal(e.exclude_recursion, true); assert.equal(e.delay_until_recursion, 1);
 assert.equal(e.scan_depth, 4); assert.equal(e.case_sensitive, false); assert.equal(e.match_whole_words, true); assert.equal(e.enabled, false);
});

test("database readonly bindings distinguish embedded/card overlay from global mounts, keep per-book IDs and respect source disables", () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-db-lorebooks-"));
 try {
  const card = { name: "合成角色", first_mes: "合成开场", character_book: { entries: [{ id: 0, keys: [], content: "合成卡常驻", constant: true, enabled: true, extensions: { prevent_recursion: true, exclude_recursion: true } }, { id: 1, keys: ["专用词"], content: "合成卡关键词", enabled: true, extensions: { prevent_recursion: true, exclude_recursion: true } }] } };
  writeFileSync(join(cwd, "card.json"), JSON.stringify(card));
  const global = { entries: { "0": { uid: 0, key: [], content: "全局合成大型设定".repeat(30000), constant: true, enabled: true, preventRecursion: true }, "1": { uid: 1, key: [], content: "全局手动禁用", enabled: true } } };
  writeFileSync(join(cwd, "global.json"), JSON.stringify(global));
  writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", lorebooks: ["global.json"], disabledLore: [loreFingerprint("全局手动禁用")] }));
  const overlay = overlayPathFor(cwd, card.name); mkdirSync(join(overlay, ".."), { recursive: true });
  writeFileSync(overlay, JSON.stringify({ entries: [{ uid: 0, content: "当前卡补充设定", constant: true, enabled: true }] }));
  const before = readFileSync(join(cwd, "liyuan.config.json"), "utf8");
  const m = loadStageMaterials(cwd), r = createDatabasePluginReadonlyLorebooks(cwd, m);
  assert.equal(r.characterBookNames.length, 2); assert.equal(r.globalBookNames.length, 1);
  const bound = r.characterBookNames.flatMap(n => r.readonlyBooks[n].entries);
  assert.equal(bound.length, 3); assert.ok(!bound.some(e => e.content.includes("全局")));
  assert.equal(bound[0].prevent_recursion, true); assert.equal(bound[1].exclude_recursion, true);
  const mounted = r.readonlyBooks[r.globalBookNames[0]].entries;
  assert.equal(mounted[0].uid, 0); assert.equal(bound[0].uid, 0, "UID is local to its source book");
  assert.equal(mounted[0].prevent_recursion, true); assert.equal(mounted[1].enabled, false);
  assert.equal(readFileSync(join(cwd, "liyuan.config.json"), "utf8"), before);
  assert.ok(m.entries.some(e => e.content.includes("全局合成大型设定")), "ordinary author material mounts remain unchanged");
  assert.equal(m.entries.filter(e => e.content === "全局手动禁用")[0].enabled, false);
  const config = JSON.parse(before);config.loreEntryOverrides = { [loreSourceKey("file", "global.json", loreFingerprint("全局手动禁用"), "1")]: true };
  writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify(config));
  const explicitlyEnabled = createDatabasePluginReadonlyLorebooks(cwd,loadStageMaterials(cwd));
  assert.equal(explicitlyEnabled.readonlyBooks[explicitlyEnabled.globalBookNames[0]].entries[1].enabled,true);
 } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("database embedded book identity stays stable and mounted duplicate contents do not remove original card metadata", () => {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-db-lorebook-duplicate-"));
 try {
  const row={id:3,content:"重复合成内容",keys:["触发词"],enabled:true,extensions:{prevent_recursion:true,exclude_recursion:true}};
  writeFileSync(join(cwd,"card.json"),JSON.stringify({name:"合成角色",character_book:{entries:[row]}}));
  writeFileSync(join(cwd,"copy.json"),JSON.stringify({entries:[{uid:3,content:row.content,key:row.keys,enabled:true,preventRecursion:false}]}));
  writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",lorebooks:["copy.json"]}));
  const m=loadStageMaterials(cwd),r=createDatabasePluginReadonlyLorebooks(cwd,m);
  assert.equal(r.characterBookNames.length,1);assert.equal(r.globalBookNames.length,1);
  assert.notEqual(r.characterBookNames[0],r.globalBookNames[0]);
  assert.equal(r.readonlyBooks[r.characterBookNames[0]].entries[0].prevent_recursion,true);
  assert.equal(r.readonlyBooks[r.globalBookNames[0]].entries[0].prevent_recursion,false);
  assert.equal(r.readonlyBooks[r.globalBookNames[0]].entries[0].content,row.content);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});


test("database character attachment declaration binds only its named mounted book, not every global mount", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-db-explicit-binding-"));
 try{
  writeFileSync(join(cwd,"card.json"),JSON.stringify({name:"合成角色",extensions:{world:"attached"}}));
  writeFileSync(join(cwd,"attached.json"),JSON.stringify({entries:[{uid:1,key:[],content:"显式角色绑定",constant:true,enabled:true}]}));
  writeFileSync(join(cwd,"global.json"),JSON.stringify({entries:[{uid:1,key:[],content:"无关全局挂载",constant:true,enabled:true}]}));
  writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",lorebooks:["attached.json","global.json"]}));
  const r=createDatabasePluginReadonlyLorebooks(cwd,loadStageMaterials(cwd));
  assert.equal(r.characterBookNames.length,1);assert.equal(r.globalBookNames.length,1);
  assert.equal(r.readonlyBooks[r.characterBookNames[0]].entries[0].content,"显式角色绑定");
  assert.equal(r.readonlyBooks[r.globalBookNames[0]].entries[0].content,"无关全局挂载");
 }finally{rmSync(cwd,{recursive:true,force:true});}
});


test("database readonly binding honors an explicitly absent data.character_book instead of reviving legacy top-level material", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-db-null-book-"));
 try{
  writeFileSync(join(cwd,"card.json"),JSON.stringify({name:"旧卡",character_book:{entries:[{uid:0,content:"不能复活",constant:true}]},data:{name:"合成角色",character_book:null}}));
  writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json"}));
  const m=loadStageMaterials(cwd),r=createDatabasePluginReadonlyLorebooks(cwd,m);
  assert.equal(m.card.book.length,0);assert.equal(r.characterBookNames.length,0);assert.deepEqual(r.readonlyBooks,{});
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
