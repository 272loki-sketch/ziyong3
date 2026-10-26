/** One read-only source resolver for generation, library and Tavern hosts.
 * Bindings select stored books; they never import/copy/merge their raw data.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { loadCardFile, readCardRawJson } from './card.ts';
import { applyLoreSourceState, mountedLorebookPaths, normalizeEntriesWithKeys, overlayPathFor } from './lorebook.ts';
import type { CharacterCard, LorebookEntry, RpConfig } from './types.ts';

export type WorldbookScope = 'character' | 'character_aux' | 'global' | 'chat' | 'agent';
export type WorldbookSource = 'card' | 'file' | 'agent';
export interface WorldbookFile { path: string; name: string; entryCount: number }
export interface ResolvedWorldbook {
 id: string; name: string; title: string; source: WorldbookSource; path: string; abs: string;
 scopes: WorldbookScope[]; scope: WorldbookScope; rawBook: Record<string, unknown>; entries: LorebookEntry[];
}
export interface ResolvedWorldbooks {
 books: ResolvedWorldbook[]; primary: ResolvedWorldbook | null;
 declaredPrimary: string | null; primaryResolution: 'bound' | 'embedded' | 'none';
 embedded: { name: string; active: boolean; entryCount: number } | null;
}
const absolute = (cwd: string, path: string) => resolve(cwd, path);
export const worldbookCardKey = (path: string): string => normalize(path.replace(/\\/g, '/')).replace(/\\/g, '/');
const list = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => v.trim().replace(/\\/g, '/')))] : [];
export function scopedLorebookPaths(config: RpConfig, scope: 'global' | 'character_aux' | 'chat', sessionId?: string): string[] {
 if (scope === 'global') return mountedLorebookPaths(config);
 const key = worldbookCardKey(config.card);
 return list(scope === 'character_aux' ? config.lorebookBindings?.character?.[key] : sessionId ? config.lorebookBindings?.chat?.[sessionId]?.[key] : []);
}
export function selectedLorebookPaths(config: RpConfig, sessionId?: string): string[] {
 return [...new Set((['global', 'character_aux', 'chat'] as const).flatMap(scope => scopedLorebookPaths(config, scope, sessionId)))];
}
export function setScopedLorebooks(config: RpConfig, scope: 'character_aux' | 'chat', paths: string[], sessionId?: string): RpConfig {
 const key = worldbookCardKey(config.card), bindings = { ...config.lorebookBindings };
 if (scope === 'character_aux') bindings.character = { ...bindings.character, [key]: list(paths) };
 else {
  if (!sessionId) throw Error('当前聊天身份不可用，不能绑定聊天世界书');
  bindings.chat = { ...bindings.chat, [sessionId]: { ...bindings.chat?.[sessionId], [key]: list(paths) } };
 }
 return { ...config, lorebookBindings: bindings };
}
/** Only the library and explicitly configured directories are discoverable.
 * An untrusted extensions.world string cannot authorize an arbitrary filesystem path.
 */
export function worldbookDirectorySpecs(cwd: string, config: RpConfig, sessionId?: string): Array<{ abs: string; relBase: string }> {
 const specs = [{ abs: join(cwd, 'assets/lorebooks'), relBase: 'assets/lorebooks' }];
 const configured = [...selectedLorebookPaths(config, sessionId), ...Object.values(config.lorebookBindings?.primary ?? {}).map(binding => binding.path), ...Object.values(config.lorebookBindings?.character ?? {}).flat(), ...Object.values(config.lorebookBindings?.chat ?? {}).flatMap(cards => Object.values(cards).flat())];
 for (const path of list(configured)) {
  const base = dirname(path), abs = absolute(cwd, base);
  if (!specs.some(s => s.abs === abs)) specs.push({ abs, relBase: base });
 }
 return specs;
}
const fileMetadata = new Map<string, { stamp: string; metadata: Omit<WorldbookFile, "path"> | null }>();
export function listWorldbookFiles(cwd: string, config: RpConfig, sessionId?: string): WorldbookFile[] {
 const out: WorldbookFile[] = [];
 for (const spec of worldbookDirectorySpecs(cwd, config, sessionId)) {
  if (!existsSync(spec.abs)) continue;
  for (const file of readdirSync(spec.abs).sort()) {
   if (!file.endsWith('.json')) continue;
   const abs = join(spec.abs, file);
   try {
    const stat = statSync(abs);
    if (!stat.isFile()) continue;
    const stamp = [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(':');
    let cached = fileMetadata.get(abs);
    if (!cached || cached.stamp !== stamp) {
     let metadata: Omit<WorldbookFile, 'path'> | null = null;
     try {
      const raw = JSON.parse(readFileSync(abs, 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') metadata = {
       name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : basename(file, '.json'), entryCount: normalizeEntriesWithKeys(raw.entries).length,
      };
     } catch { /* Invalid files have no bindable book name. */ }
     cached = { stamp, metadata };
     if (fileMetadata.size >= 1024) fileMetadata.clear();
     fileMetadata.set(abs, cached);
    }
    if (cached.metadata) out.push({ path: (spec.relBase === '.' ? `./${file}` : `${spec.relBase}/${file}`).replace(/\\/g, '/'), ...cached.metadata });
   } catch { /* Invalid library objects are not names to which a card can bind. */ }
  }
 }
 return out;
}
function fileIdentity(abs: string): string { return `file:${realpathSync(abs)}`; }
function findBoundFile(cwd: string, catalog: WorldbookFile[], reference: string): WorldbookFile | undefined {
 const pathMatches = catalog.filter(book => worldbookCardKey(book.path) === worldbookCardKey(reference) ||
  (isAbsolute(reference) && absolute(cwd, book.path) === absolute(cwd, reference)));
 const matches = pathMatches.length ? pathMatches : catalog.filter(book => [book.name, basename(book.path), basename(book.path, '.json')].includes(reference));
 const unique = [...new Map(matches.map(book => [fileIdentity(absolute(cwd, book.path)), book])).values()];
 if (unique.length > 1) throw Error(`角色绑定的世界书名称不唯一：${reference}，请使用库内明确路径`);
 return unique[0];
}
export function resolveWorldbooks(cwd: string, config: RpConfig, options: { card?: CharacterCard; rawCard?: Record<string, unknown>; sessionId?: string } = {}): ResolvedWorldbooks {
 const books: ResolvedWorldbook[] = [], byId = new Map<string, ResolvedWorldbook>();
 let primary: ResolvedWorldbook | null = null, declaredPrimary: string | null = null, embedded: ResolvedWorldbooks['embedded'] = null;
 let primaryResolution: ResolvedWorldbooks['primaryResolution'] = 'none';
 const catalog = listWorldbookFiles(cwd, config, options.sessionId);
 const add = (source: WorldbookSource, path: string, abs: string, title: string, rawBook: Record<string, unknown>, scope: WorldbookScope): ResolvedWorldbook => {
  const id = source === 'file' ? fileIdentity(abs) : `${source}:${realpathSync(abs)}`;
  const prior = byId.get(id);
  if (prior) { if (!prior.scopes.includes(scope)) prior.scopes.push(scope); return prior; }
  const book: ResolvedWorldbook = { id, name: title, title, source, path, abs, rawBook, scope, scopes: [scope], entries: [] };
  books.push(book); byId.set(id, book); return book;
 };
 const addFile = (path: string, scope: WorldbookScope, known?: WorldbookFile): ResolvedWorldbook | null => {
  const abs = absolute(cwd, path);
  if (!existsSync(abs)) return null; // Legacy missing mounts remain in configuration, not silently repaired.
  const rawBook = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
  if (!rawBook || !rawBook.entries || typeof rawBook.entries !== 'object') throw Error(`世界书格式无效：${path}`);
  const title = typeof rawBook.name === 'string' && rawBook.name.trim() ? rawBook.name.trim() : known?.name ?? basename(path, '.json');
  return add('file', path, abs, title, rawBook, scope);
 };
 let card: CharacterCard | undefined;
 if (config.card && existsSync(absolute(cwd, config.card))) {
  const abs = absolute(cwd, config.card);
  card = options.card ?? loadCardFile(abs);
  const raw = options.rawCard ?? readCardRawJson(abs).raw;
  const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : raw;
  const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions as Record<string, unknown> : {};
  declaredPrimary = typeof extensions.world === 'string' && extensions.world.trim() ? extensions.world.trim().replace(/\\/g, '/') : null;
  const rawEmbedded = ('character_book' in data ? data.character_book : raw.character_book) as Record<string, unknown> | undefined;
  if (rawEmbedded && typeof rawEmbedded === 'object' && !Array.isArray(rawEmbedded)) embedded = {
   name: typeof rawEmbedded.name === 'string' && rawEmbedded.name.trim() ? rawEmbedded.name.trim() : `${card.name}'s Lorebook`, active: false, entryCount: normalizeEntriesWithKeys(rawEmbedded.entries).length,
  };
  const mapped = config.lorebookBindings?.primary?.[worldbookCardKey(config.card)];
  const reference = mapped?.reference === declaredPrimary ? mapped.path : declaredPrimary;
  const bound = reference ? findBoundFile(cwd, catalog, reference) : undefined;
  if (bound) {
   const configured = selectedLorebookPaths(config, options.sessionId).find(path => existsSync(absolute(cwd, path)) && fileIdentity(absolute(cwd, path)) === fileIdentity(absolute(cwd, bound.path)));
   primary = addFile(configured ?? bound.path, 'character', bound); primaryResolution = 'bound';
  }
  else if (embedded) { primary = add('card', config.card, abs, embedded.name, rawEmbedded!, 'character'); embedded.active = true; primaryResolution = 'embedded'; }
 }
 for (const scope of ['character_aux', 'global', 'chat'] as const) for (const path of scopedLorebookPaths(config, scope, options.sessionId)) addFile(path, scope);
 if (card) {
  const abs = overlayPathFor(cwd, card.name);
  if (existsSync(abs)) add('agent', config.card, abs, `${card.name} · 补充设定`, JSON.parse(readFileSync(abs, 'utf8')), 'agent');
 }
 const usedNames = new Set<string>();
 for (const book of books) if (book.source === 'file' && books.filter(other => other.source === 'file' && other.title === book.title).length > 1) book.name = `${book.title} · ${book.path}`;
 for (const book of books) {
  if (usedNames.has(book.name)) book.name = book.source === 'file' && books.filter(b => b.title === book.title && b.source === 'file').length === 1 ? `${book.title} · 独立书` : `${book.title} · ${book.path}`;
  if (usedNames.has(book.name) || ['__proto__', 'constructor', 'prototype'].includes(book.name)) throw Error('世界书显示名称冲突或使用了保留字段，请明确重命名');
  usedNames.add(book.name);
  // Same stored book can be selected in several scopes; load once as in Luker.
  book.scope = book.scopes.includes('global') ? 'global' : book.scopes.includes('chat') ? 'chat' : book.scopes[0];
  book.entries = applyLoreSourceState(normalizeEntriesWithKeys(book.rawBook.entries), config, book.source, book.path).map(entry => ({ ...entry,
   source: book.source === 'file' ? `lorebook:${book.path}` : book.source === 'agent' ? 'overlay' : 'card',
   bookId: book.id, worldbookName: book.name, worldbookScope: book.scope }));
 }
 return { books, primary, declaredPrimary, primaryResolution, embedded };
}
export function worldbookSelections(resolved: ResolvedWorldbooks): { primary: string | null; additional: string[]; global: string[]; chat: string[] } {
 return { primary: resolved.primary?.name ?? null,
  additional: resolved.books.filter(b => b !== resolved.primary && (b.scopes.includes('character_aux') || b.scopes.includes('agent'))).map(b => b.name),
  global: resolved.books.filter(b => b.scopes.includes('global')).map(b => b.name), chat: resolved.books.filter(b => b.scopes.includes('chat')).map(b => b.name) };
}
/** Preserve every raw row, including disabled/empty rows and unknown native fields. */
export function projectWorldbookRows(book: ResolvedWorldbook): Array<Record<string, unknown>> {
 const rows = book.rawBook.entries as Record<string, Record<string, unknown>> | undefined;
 return book.entries.map(entry => {
  const raw = rows?.[entry.entryKey!], fields = raw?.extensions && typeof raw.extensions === 'object' ? raw.extensions as Record<string, unknown> : {};
  const position = raw?.position ?? fields.position ?? 0;
  return { ...raw, ...fields, uid: entry.uid, entryKey: entry.entryKey, key: entry.keys, keys: entry.keys, keysecondary: entry.secondaryKeys,
   name: entry.comment, comment: entry.comment, content: entry.content, constant: entry.constant, selective: entry.selective,
   enabled: entry.enabled, disable: !entry.enabled, order: entry.order,
   position: position === 'before_char' ? 0 : position === 'after_char' ? 1 : position, depth: raw?.depth ?? fields.depth ?? 4 };
 });
}
export function nativeWorldbookContext(resolved: ResolvedWorldbooks): { readonlyBooks: Record<string, { entries: Array<Record<string, unknown>> }>; worldbookSelections: ReturnType<typeof worldbookSelections> } {
 const readonlyBooks: Record<string, { entries: Array<Record<string, unknown>> }> = Object.create(null);
 for (const book of resolved.books) readonlyBooks[book.name] = { entries: projectWorldbookRows(book) };
 return { readonlyBooks, worldbookSelections: worldbookSelections(resolved) };
}
