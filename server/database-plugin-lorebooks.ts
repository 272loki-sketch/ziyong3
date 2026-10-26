import { createHash } from "node:crypto";
import { resolveWorldbooks } from "../src/worldbook-bindings.ts";
import { applyLoreSourceState, normalizeEntriesWithKeys } from "../src/lorebook.ts";
import { stripProtocolEntries } from "../src/protocol-detect.ts";
import type { StageMaterials } from "../src/stage/materials.ts";
import type { LorebookEntry } from "../src/types.ts";

type Raw = Record<string, any>;
export interface DatabasePluginReadonlyLorebooks {
 readonlyBooks: Record<string, { entries: Raw[] }>;
 characterBookNames: string[];
 globalBookNames: string[];
}

/** Translate source options at the host boundary; do not change the author's normalized material set. */
export function databasePluginReadonlyEntry(entry: LorebookEntry, raw: Raw): Raw {
 const extensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions) ? raw.extensions : {};
 const value = (snake: string, camel: string) => raw[snake] ?? extensions[snake] ?? raw[camel] ?? extensions[camel];
 const translated: Raw = {};
 for (const [snake, camel] of [
  ["prevent_recursion", "preventRecursion"], ["exclude_recursion", "excludeRecursion"],
  ["delay_until_recursion", "delayUntilRecursion"], ["scan_depth", "scanDepth"],
  ["case_sensitive", "caseSensitive"], ["match_whole_words", "matchWholeWords"],
  ["use_group_scoring", "useGroupScoring"], ["automation_id", "automationId"],
  ["group_prioritized", "groupOverride"], ["group_weight", "groupWeight"],
 ]) {
  const option = value(snake, camel);
  if (option !== undefined) translated[snake] = option;
 }
 return {
  ...extensions, ...raw, ...translated,
  uid: entry.uid, entryKey: entry.entryKey, comment: entry.comment, name: entry.comment,
  // Normalization may change CRLF. Worldbook transport must retain the source text byte-for-byte.
  content: typeof raw.content === "string" ? raw.content : entry.content,
  keys: [...entry.keys], key: [...entry.keys], keysecondary: [...entry.secondaryKeys], keys_secondary: [...entry.secondaryKeys],
  type: entry.constant ? "constant" : "keyword", constant: entry.constant,
  enabled: entry.enabled, selective: entry.selective, order: entry.order,
  // Card exports may have a textual position and the native numeric position in extensions.
  position: extensions.position ?? raw.position,
  depth: raw.depth ?? extensions.depth, role: raw.role ?? extensions.role,
 };
}

/** Global mounts are visible for explicit selection, not implicitly reported as character attachments. */
export function createDatabasePluginReadonlyLorebooks(cwd: string, materials: StageMaterials): DatabasePluginReadonlyLorebooks {
 const result: DatabasePluginReadonlyLorebooks = { readonlyBooks: {}, characterBookNames: [], globalBookNames: [] };
 const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
 const add = (name: string, rawEntries: unknown, source: "card" | "file" | "agent", path: string, characterBound: boolean) => {
  const rows = rawEntries && typeof rawEntries === "object" ? rawEntries as Raw : {};
  const normalized = applyLoreSourceState(normalizeEntriesWithKeys(rawEntries), materials.config, source, path);
  const entries = materials.nativeTavernPlugins ? normalized : stripProtocolEntries(normalized).entries;
  result.readonlyBooks[name] = { entries: entries.map(entry => databasePluginReadonlyEntry(entry, rows[entry.entryKey!] ?? {})) };
  (characterBound ? result.characterBookNames : result.globalBookNames).push(name);
 };
 const resolved = materials.worldbooks ?? resolveWorldbooks(cwd, materials.config, { card: materials.card, rawCard: materials.rawCard });
 for (const book of resolved.books) {
  const name = book.source === "card" ? `Liyuan-Materials-Readonly-${hash(materials.config.card || "nocard")}`
   : book.source === "agent" ? `Liyuan-Overlay-Readonly-${hash(materials.config.card)}` : `Liyuan-Mounted-Readonly-${hash(book.path)}`;
  const characterBound = book.scopes.includes("character") || book.scopes.includes("character_aux") || book.scopes.includes("agent");
  add(name, book.rawBook.entries, book.source, book.path, characterBound);
 }
 return result;
}
