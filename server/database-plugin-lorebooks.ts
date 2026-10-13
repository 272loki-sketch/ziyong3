import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { readJsonFile } from "../src/jsonio.ts";
import { applyLoreSourceState, mountedLorebookPaths, normalizeEntriesWithKeys, overlayPathFor } from "../src/lorebook.ts";
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
  uid: entry.uid, comment: entry.comment, name: entry.comment,
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
 const rawCard = materials.rawCard, card = rawCard.data && typeof rawCard.data === "object" ? rawCard.data as Raw : rawCard;
 const embedded = Object.hasOwn(card, "character_book") ? card.character_book : rawCard.character_book;
 if (embedded && typeof embedded === "object") {
  // Preserve the prior card-book alias, but no longer place unrelated global books inside it.
  add(`Liyuan-Materials-Readonly-${hash(materials.config.card || "nocard")}`, (embedded as Raw).entries, "card", materials.config.card, true);
 }
 const cardExtensions = Object.hasOwn(card, "extensions") ? card.extensions : rawCard.extensions;
 const declaredWorld = typeof cardExtensions?.world === "string" ? cardExtensions.world.trim() : "";
 for (const path of mountedLorebookPaths(materials.config)) {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  if (!existsSync(absolute)) continue;
  const book = readJsonFile(absolute) as Raw;
  const bound = !!declaredWorld && [path, basename(path), basename(path, ".json"), book.name].includes(declaredWorld);
  add(`Liyuan-Mounted-Readonly-${hash(path)}`, book.entries, "file", path, bound);
 }
 const overlay = overlayPathFor(cwd, materials.card.name);
 if (existsSync(overlay)) add(`Liyuan-Overlay-Readonly-${hash(materials.config.card)}`, (readJsonFile(overlay) as Raw).entries, "agent", materials.config.card, true);
 return result;
}
