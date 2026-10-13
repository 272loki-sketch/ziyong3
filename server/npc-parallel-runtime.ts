import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { tavernVendorAsset } from './tavern-plugin-vendor.ts';
import { classifyModelFailure } from '../src/stage/model-failure.ts';

/** Public diagnostic categories only: never echo provider payloads, prompts or secrets. */
export function npcManagedFailureReason(error:unknown):string {
 const raw=error instanceof Error?error.message:String(error);
 if(/输出触及上限|截断|finish_reason.*length/i.test(raw))return '输出达到上限，截断结果未采用（在场判定也需要足够的推理输出预算）';
 const failure=classifyModelFailure(error);
 const labels={auth:'模型凭据无效或已过期',model:'独立侧写模型不可用',quota:'供应商额度不足','rate-limit':'供应商限流',timeout:'受管模型超时',transport:'模型网络或流式连接失败',format:'模型返回空文本或无效结构',unknown:'未知模型错误，请查看本拍请求诊断'};
 return labels[failure.kind]+(failure.statusCode?`（HTTP ${failure.statusCode}）`:'');
}

type JsonRecord = Record<string, unknown>;
type NpcParallelRole = 'system' | 'user' | 'assistant';
export interface NpcParallelMessage { role: NpcParallelRole; content: string }
export interface NpcParallelChatMessage {
  entryId: string;
  mes: string;
  is_user: boolean;
  name?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface NpcParallelNpc { name: string; notes?: string; pov?: string; always?: boolean; weight?: number }
export interface NpcParallelGenerateRequest {
  messages: NpcParallelMessage[];
  maxTokens: number;
  temperature?: number;
  purpose?: string;
}
export interface NpcParallelResultEntry { name: string; text: string; info?: string; pov?: string; ts?: number }
export interface NpcParallelCandidate {
  root: string;
  version: string;
  commit: string;
  sha256: string;
  manifest: Record<string, unknown>;
}
export interface NpcParallelSourceLike {
  active(): NpcParallelCandidate | null;
  resolveAsset(rel: string, candidate?: NpcParallelCandidate): string | null;
}
export interface NpcParallelRunInput {
  sessionId: string;
  card: string;
  sourceEntryId: string;
  chat: NpcParallelChatMessage[];
  npcs: NpcParallelNpc[];
  worldbooks: Record<string, { entries: Array<Record<string, unknown>> }>;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  constraintText: string;
  userName?: string;
  characterName?: string;
  signal?: AbortSignal;
  guard: () => void;
  generate: (request: NpcParallelGenerateRequest, signal?: AbortSignal) => Promise<string>;
}
export interface NpcParallelRunResult {
  entries: NpcParallelResultEntry[];
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
  calls: number;
  errors: string[];
  version: string;
  commit: string;
}

const MAX_CALLS = 8;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const MAX_RUN_MS = 15 * 60 * 1000;
export async function npcWaitForPage(check: () => Promise<boolean>, timeoutMs: number, message: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const ready = await Promise.race([Promise.resolve().then(() => {
        signal.throwIfAborted();
        return check();
      }), aborted]);
      // A late check must not resume polling or report success after cancellation.
      signal.throwIfAborted();
      if (ready) return;
      await Promise.race([delay(75, undefined, { signal }), aborted]);
    }
    throw new Error(message);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
const MAX_MESSAGES = 2048;
const ASSET_FILES: Record<string, string> = {
  '/npc-parallel/host.js': 'web/public/npc-parallel/host.js',
  '/npc-parallel/host.css': 'web/public/npc-parallel/host.css',
  '/npc-parallel/script.js': 'web/public/npc-parallel/script.js',
  '/npc-parallel/scripts/extensions.js': 'web/public/npc-parallel/extensions.js',
};
const VENDOR_NAMES: Record<string, string> = {
  '/npc-parallel/vendor/jquery.js': 'jquery.js',
  '/npc-parallel/vendor/jquery-ui.js': 'jquery-ui.js',
  '/npc-parallel/vendor/jquery-touch-punch.js': 'jquery-touch-punch.js',
  '/npc-parallel/vendor/toastr.js': 'toastr.js',
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const safeJson = (value: unknown): string => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);

function safeAssetPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('NPC Parallel 上游清单包含不安全资源路径');
  }
  return value;
}
function declaredPluginAssets(manifest: Record<string, unknown>): string[] {
  const entry = safeAssetPath(typeof manifest.js === 'string' ? manifest.js : '');
  const css = manifest.css == null || manifest.css === '' ? '' : safeAssetPath(manifest.css);
  const raw = manifest.assets;
  let assets: string[] = [];
  if (raw !== undefined) {
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) assets = raw as string[];
    else if (isRecord(raw)) {
      assets = Object.values(raw).map(item => {
        if (typeof item === 'string') return item;
        if (isRecord(item) && typeof item.path === 'string') return item.path;
        throw new Error('NPC Parallel manifest.assets 声明格式未知，候选版本 fail-closed');
      });
    } else throw new Error('NPC Parallel manifest.assets 声明格式未知，候选版本 fail-closed');
  }
  const all = [...new Set([entry, ...(css ? [css] : []), ...assets].map(item => safeAssetPath(item)))];
  for (const asset of all) {
    const ext = asset.split('.').at(-1)?.toLowerCase();
    if (!['js', 'mjs', 'css', 'json', 'svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'woff', 'woff2', 'ttf', 'otf'].includes(ext ?? '')) {
      throw new Error(`NPC Parallel manifest声明了宿主不支持的资源类型：${asset}`);
    }
  }
  if (manifest.requires !== undefined && (!Array.isArray(manifest.requires) || manifest.requires.length > 0)) {
    throw new Error('NPC Parallel manifest声明了当前宿主不支持的必需依赖');
  }
  return all;
}
function pluginAssetMime(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase();
  return ({
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}
const TEMP_RUN_SETTINGS = ['pickBeforeGen', 'minGenTokens', 'delayMs', 'autoSyncDatabase', 'autoDetectPresence'] as const;
function mergeRunSettings(snapshot: Record<string, unknown>, original: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = clone(snapshot);
  const prior = original ?? {};
  for (const key of TEMP_RUN_SETTINGS) {
    if (Object.hasOwn(prior, key)) result[key] = clone(prior[key]);
    else delete result[key];
  }
  // Restore secrets from the original in-memory setting object, but keep all non-secret migrations/defaults/unknowns from the upstream snapshot.
  const priorApi = prior.customApi;
  const resultApi = result.customApi;
  if (isRecord(priorApi) && isRecord(resultApi)) {
    for (const key of ['apiKey', 'proxy_password', 'key', 'secret']) {
      if (Object.hasOwn(priorApi, key)) resultApi[key] = clone(priorApi[key]);
      else delete resultApi[key];
    }
    if (Array.isArray(priorApi.endpoints) && Array.isArray(resultApi.endpoints)) {
      for (let index = 0; index < resultApi.endpoints.length; index++) {
        const current = resultApi.endpoints[index];
        const previous = priorApi.endpoints[index];
        if (!isRecord(current)) continue;
        for (const key of ['apiKey', 'proxy_password', 'key', 'secret']) {
          if (isRecord(previous) && Object.hasOwn(previous, key)) current[key] = clone(previous[key]);
          else if (!isRecord(previous) && index === 0 && Object.hasOwn(priorApi, key)) current[key] = clone(priorApi[key]);
          else delete current[key];
        }
      }
    }
  }
  // The roster is source-scoped in metadata, never a global extension setting.
  delete result.npcs;
  delete result.ignoredNpcs;
  return result;
}
function normalizeSettings(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const copy = clone(value ?? {});
  for (const key of ['npcs', 'ignoredNpcs']) delete copy[key];
  const customApi = copy.customApi;
  if (isRecord(customApi)) {
    if (typeof customApi.apiKey === 'string' && customApi.apiKey) customApi.apiKey = 'liyuan-managed-proxy';
    if (Array.isArray(customApi.endpoints)) {
      customApi.endpoints = customApi.endpoints.map(endpoint => {
        if (!isRecord(endpoint)) return endpoint;
        const next = { ...endpoint };
        for (const key of ['apiKey', 'proxy_password', 'key', 'secret']) if (typeof next[key] === 'string' && next[key]) next[key] = 'liyuan-managed-proxy';
        return next;
      });
    }
  }
  return copy;
}
function normalizeWorldbooks(value: NpcParallelRunInput['worldbooks']): NpcParallelRunInput['worldbooks'] {
  if (!isRecord(value)) throw new Error('NPC Parallel 世界书快照结构无效');
  const output: NpcParallelRunInput['worldbooks'] = {};
  for (const [name, book] of Object.entries(value)) {
    if (!isRecord(book) || !Array.isArray(book.entries) || book.entries.some(entry => !isRecord(entry))) throw new Error(`NPC Parallel 世界书格式不支持：${name}`);
    output[name] = clone(book) as { entries: Array<Record<string, unknown>> };
  }
  return output;
}
function normalizeChat(input: NpcParallelRunInput): { chat: NpcParallelChatMessage[]; sourceIndex: number; sourceText: string } {
  if (!Array.isArray(input.chat) || !input.chat.length) throw new Error('NPC Parallel 没有可用的分支聊天快照');
  const ids = new Set<string>();
  const chat = clone(input.chat).map(item => {
    if (!isRecord(item) || typeof item.entryId !== 'string' || !item.entryId || typeof item.mes !== 'string' || typeof item.is_user !== 'boolean') {
      throw new Error('NPC Parallel 聊天快照缺少 entryId/mes/is_user');
    }
    if (ids.has(item.entryId)) throw new Error('NPC Parallel 聊天快照含重复 entryId');
    ids.add(item.entryId);
    const next: NpcParallelChatMessage = { ...item, extra: isRecord(item.extra) ? clone(item.extra) : {} } as NpcParallelChatMessage;
    // SillyTavern compatibility IDs are written only into this detached virtual chat.
    next.message_id = item.entryId;
    next.__liyuanEntryId = item.entryId;
    return next;
  });
  const sourceIndex = chat.findIndex(message => message.entryId === input.sourceEntryId);
  if (sourceIndex < 0 || chat[sourceIndex].is_user || chat[sourceIndex].is_system === true) throw new Error('NPC Parallel sourceEntryId 不在当前分支或不是 AI 正文');
  let lastAiIndex = -1;
  for (let index = chat.length - 1; index >= 0; index--) if (!chat[index].is_user && chat[index].is_system !== true) { lastAiIndex = index; break; }
  if (lastAiIndex !== sourceIndex) throw new Error('NPC Parallel 只允许对当前分支最新的 AI 正文执行');
  const source = chat[sourceIndex];
  const sidecar = source.extra?.npc_parallel;
  if (Array.isArray(sidecar) && sidecar.length) throw new Error('该正文来源已有侧写候选；拒绝重复生成或覆盖历史候选');
  if (/<!--npcp:start-->/i.test(source.mes)) throw new Error('该正文已含上游侧写块；拒绝清理或重写原文');
  return { chat, sourceIndex, sourceText: source.mes };
}
function extractEntries(extra: Record<string, unknown>): NpcParallelResultEntry[] {
  const raw = extra.npc_parallel;
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.text !== 'string' || !item.text.trim()) {
      throw new Error('原版插件返回了不完整的 npc_parallel 结构；候选未提交');
    }
    const entry: NpcParallelResultEntry = { name: item.name, text: item.text };
    if (typeof item.info === 'string') entry.info = item.info;
    if (typeof item.pov === 'string') entry.pov = item.pov;
    if (Number.isFinite(Number(item.ts))) entry.ts = Number(item.ts);
    return entry;
  });
}
function assertAppendOnly(original: string, current: unknown, entries: NpcParallelResultEntry[]): void {
  if (typeof current !== 'string') throw new Error('原版插件修改了聊天消息文本类型');
  if (!entries.length) {
    // The upstream stripBlocks() trims only the virtual copy's trailing whitespace before it runs.
    if (current !== original.trimEnd()) throw new Error('原版插件在没有侧写结果时改动了正文内容；拒绝候选');
    return;
  }
  const prefix = original.trimEnd();
  if (!current.startsWith(prefix)) throw new Error('原版插件改写了冻结正文前缀；拒绝候选');
  const suffix = current.slice(prefix.length);
  const blocks = [...suffix.matchAll(/<!--npcp:start-->[\s\S]*?<!--npcp:end-->/g)];
  if (blocks.length !== entries.length || suffix.replace(/<!--npcp:start-->[\s\S]*?<!--npcp:end-->/g, '').trim() !== '') {
    throw new Error('原版插件输出不只包含结构化侧写折叠块；拒绝候选');
  }
}

export class NpcParallelRuntime {
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #server: Server | null = null;
  #origin = '';
  #active = false;
  #closed = false;
  #abort: AbortController | null = null;
  #generations = new Set<Promise<string>>();
  #runDone: Promise<void> | null = null;
  #resetting = 0;
  #currentCandidate: NpcParallelCandidate | null = null;

  readonly options: { assetsCwd: string; sources: NpcParallelSourceLike };

  constructor(options: { assetsCwd: string; sources: NpcParallelSourceLike }) {
    if (!options?.assetsCwd || !options.sources) throw new TypeError('NpcParallelRuntime requires assetsCwd and sources');
    this.options = options;
  }

  busy(): boolean { return this.#active || this.#resetting > 0; }

  /** Reusable realm reset for source activation/update hooks. */
  async reset(): Promise<void> {
    this.#resetting++;
    try {
      this.#abort?.abort(new DOMException('NPC Parallel runtime reset', 'AbortError'));
      await this.#runDone;
      await this.#disposeRuntime();
    } finally {
      this.#resetting--;
    }
  }

  /** Terminal shutdown. Call reset() from source activation hooks so a later run remains possible. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort?.abort(new DOMException('NPC Parallel runtime closed', 'AbortError'));
    await this.reset();
  }

  async run(input: NpcParallelRunInput): Promise<NpcParallelRunResult> {
    if (this.busy()) throw new Error('NPC Parallel runtime is busy');
    if (this.#closed) throw new Error('NPC Parallel runtime is closed');
    if (!input || typeof input.guard !== 'function' || typeof input.generate !== 'function') throw new TypeError('NpcParallelRuntime.run requires guard and managed generate callbacks');
    if (!input.sessionId || !input.card || !input.sourceEntryId) throw new Error('NPC Parallel 缺少 session/card/source 绑定');
    if (typeof input.constraintText !== 'string') throw new Error('NPC Parallel constraintText 必须是字符串');
    if (input.settings?.enabled === false || input.settings?.autoTrigger === false) throw new Error('NPC Parallel 自动任务被原版 enabled/autoTrigger 设置显式关闭');
    if (!Array.isArray(input.npcs) || input.npcs.length > 100) throw new Error('NPC Parallel NPC 名单无效或超过运行器上限');
    const candidate = this.options.sources.active();
    if (!candidate) throw new Error('NPC Parallel 原版来源尚未安装/启用');
    if (!/^[0-9a-f]{40}$/i.test(candidate.commit) || !/^[0-9a-f]{64}$/i.test(candidate.sha256) || !candidate.version || !isRecord(candidate.manifest)) {
      throw new Error('NPC Parallel 原版来源指针无效');
    }
    const { chat, sourceIndex, sourceText } = normalizeChat(input);
    const worldbooks = normalizeWorldbooks(input.worldbooks);
    const roster = input.npcs.map(npc => {
      if (!isRecord(npc) || typeof npc.name !== 'string' || !npc.name.trim()) throw new Error('NPC Parallel 名单含无效人物');
      return clone(npc);
    });
    input.guard();
    if (!roster.length) {
      return { entries: [], settings: clone(input.settings ?? {}), metadata: clone(input.metadata ?? {}), calls: 0, errors: [], version: candidate.version, commit: candidate.commit };
    }
    const identity = { sessionId: input.sessionId, card: input.card, sourceEntryId: input.sourceEntryId };
    this.#active = true;
    let finishRun!: () => void;
    this.#runDone = new Promise<void>(resolve => { finishRun = resolve; });
    this.#currentCandidate = candidate;
    const controller = new AbortController();
    this.#abort = controller;
    let calls = 0;
    const errors: string[] = [];
    const jobToken = randomBytes(24).toString('base64url');
    const hardTimer = setTimeout(() => controller.abort(new DOMException('NPC Parallel task timeout', 'TimeoutError')), MAX_RUN_MS);
    const signals = [controller.signal, ...(input.signal ? [input.signal] : [])];
    const signal = AbortSignal.any(signals);
    const safeError = (message: string) => {
      if (!errors.includes(message)) errors.push(message);
    };
    const assertBound = () => {
      if (this.#closed || signal.aborted) throw signal.reason ?? new DOMException('NPC Parallel task aborted', 'AbortError');
      input.guard();
      if (input.sessionId !== identity.sessionId || input.card !== identity.card || input.sourceEntryId !== identity.sourceEntryId) throw new Error('NPC Parallel session/card/source binding changed during the job');
      const active = this.options.sources.active();
      if (!active || active.commit !== candidate.commit || active.sha256 !== candidate.sha256 || active.version !== candidate.version) {
        throw new Error('NPC Parallel active source changed during the job');
      }
    };
    const generate = async (request: NpcParallelGenerateRequest, requestSignal?: AbortSignal): Promise<string> => {
      assertBound();
      if (calls >= MAX_CALLS) {
        safeError('NPC Parallel 单任务受管模型调用达到8次上限');
        throw new Error('NPC Parallel 单任务受管模型调用达到8次上限');
      }
      if (!isRecord(request) || !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > MAX_MESSAGES) {
        throw new Error('NPC Parallel 受管生成请求的 messages 无效');
      }
      const messages = request.messages.map(message => {
        if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string') {
          throw new Error('NPC Parallel 受管生成遇到未知消息格式');
        }
        return { role: message.role as NpcParallelRole, content: message.content };
      });
      const maxTokens = Math.floor(Number(request.maxTokens));
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 100000) throw new Error('NPC Parallel maxTokens 超出受管范围');
      calls++;
      const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      try {
        combined.throwIfAborted();
        const content = await input.generate({
          messages: [{ role: 'system', content: input.constraintText }, ...messages],
          maxTokens,
          ...(Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {}),
          ...(typeof request.purpose === 'string' ? { purpose: request.purpose.slice(0, 160) } : {}),
        }, combined);
        combined.throwIfAborted();
        assertBound();
        if (typeof content !== 'string' || !content.trim()) throw new Error('受管模型返回空内容');
        return content;
      } catch (error) {
        if (combined.aborted) safeError(combined.reason?.name === 'TimeoutError' ? 'NPC Parallel 任务超时' : 'NPC Parallel 任务已取消');
        else safeError('NPC Parallel 受管模型请求失败：'+npcManagedFailureReason(error));
        const wrapped = new Error(combined.aborted ? (combined.reason?.message ?? 'NPC Parallel task aborted') : '受管模型请求失败：'+npcManagedFailureReason(error));
        wrapped.name = combined.aborted ? (combined.reason?.name ?? 'AbortError') : 'Error';
        throw wrapped;
      }
    };
    const managedGenerate = (request: NpcParallelGenerateRequest, requestSignal?: AbortSignal): Promise<string> => {
      // Register before invoking user code; an HTTP disconnect does not settle the model callback.
      const task = Promise.resolve().then(() => generate(request, requestSignal));
      this.#generations.add(task);
      void task.then(() => this.#generations.delete(task), () => this.#generations.delete(task));
      return task;
    };
    try {
      await this.#start(candidate, input, { chat, sourceIndex, worldbooks, roster, jobToken, managedGenerate, assertBound, signal });
      assertBound();
      await this.#page!.evaluate(() => (window as any).LiyuanNpcParallelHost.armRuntimeTask());
      assertBound();
      // Precisely emit the upstream public event once. Its MESSAGE_RECEIVED listener owns the 1500ms debounce.
      await this.#page!.evaluate(() => (window as any).LiyuanNpcParallelHost.emitReceived());
      const page = this.#page!;
      await npcWaitForPage(
        () => page.evaluate(() => (window as any).LiyuanNpcParallelHost?.snapshot?.().completion?.ready === true),
        MAX_RUN_MS + 20_000,
        '原版插件没有完成保存/完成回执',
        signal,
      );
      await Promise.allSettled(this.#generations);
      assertBound();
      const snapshot = await page.evaluate(() => (window as any).LiyuanNpcParallelHost.snapshot());
      const sourceEntry = isRecord(snapshot.sourceExtra) ? extractEntries(snapshot.sourceExtra) : [];
      assertAppendOnly(sourceText, snapshot.sourceMes, sourceEntry);
      if (!isRecord(snapshot.completion) || Number(snapshot.completion.saves) < 1 || Number(snapshot.completion.edited) < 1) {
        throw new Error('原版插件没有完成真实 saveChat + MESSAGE_EDITED 回执；拒绝假成功');
      }
      const status = String(snapshot.status ?? '');
      const failureMatch = status.match(/失败\s*(\d+)/);
      if (failureMatch && Number(failureMatch[1]) > 0) safeError(`原版插件报告${Number(failureMatch[1])}名NPC生成失败`);
      if (!sourceEntry.length && roster.length && !/在场跳过\s*[1-9]/.test(status)) {
        safeError('原版插件任务完成但没有侧写结果；未冒称生成成功');
      }
      if (signal.aborted) throw signal.reason ?? new DOMException('NPC Parallel task aborted', 'AbortError');
      assertBound();
      const metadata = isRecord(snapshot.metadata) ? clone(snapshot.metadata) : {};
      const settings = mergeRunSettings(isRecord(snapshot.settings) ? snapshot.settings : {}, input.settings);
      return {
        entries: sourceEntry,
        settings,
        metadata,
        calls,
        errors,
        version: candidate.version,
        commit: candidate.commit,
      };
    } catch (error) {
      if (signal.aborted && !errors.length) safeError(signal.reason?.name === 'TimeoutError' ? 'NPC Parallel 任务超时' : 'NPC Parallel 任务已取消');
      throw error;
    } finally {
      clearTimeout(hardTimer);
      controller.abort(new DOMException('NPC Parallel task finished', 'AbortError'));
      await this.#disposeRealm().catch(() => undefined);
      // Never race drainage against a timeout: an uncooperative callback must retain the identity lock.
      await Promise.allSettled(this.#generations);
      this.#active = false;
      this.#abort = null;
      this.#currentCandidate = null;
      this.#runDone = null;
      finishRun();
    }
  }

  async #start(candidate: NpcParallelCandidate, input: NpcParallelRunInput, job: {
    chat: NpcParallelChatMessage[]; sourceIndex: number; worldbooks: NpcParallelRunInput['worldbooks']; roster: NpcParallelNpc[];
    jobToken: string; managedGenerate: (request: NpcParallelGenerateRequest, signal?: AbortSignal) => Promise<string>; assertBound: () => void;
    signal: AbortSignal;
  }): Promise<void> {
    const pluginAssets = declaredPluginAssets(candidate.manifest);
    const htmlPath = join(this.options.assetsCwd, 'web/public/npc-parallel-host.html');
    if (!existsSync(htmlPath) || !lstatSync(htmlPath).isFile()) throw new Error('NPC Parallel 原版宿主页资源缺失');
    const bootstrap = {
      mode: 'runtime',
      scope: { sessionId: input.sessionId, card: input.card, sourceEntryId: input.sourceEntryId },
      scopeKey: `runtime:${digest(`${input.sessionId}\0${input.card}`)}`,
      sourceEntryId: input.sourceEntryId,
      revision: 0,
      sessionId: input.sessionId,
      card: input.card,
      chat: job.chat,
      npcs: job.roster,
      worldbooks: job.worldbooks,
      settings: normalizeSettings(input.settings),
      metadata: clone(input.metadata ?? {}),
      constraintText: input.constraintText,
      userName: input.userName,
      characterName: input.characterName,
      manifest: candidate.manifest,
      version: candidate.version,
      jobToken: job.jobToken,
    };
    this.#server = createServer((request, response) => {
      void this.#handleRequest(request, response, candidate, bootstrap, job).catch(error => {
        if (!response.headersSent) this.#reply(response, 500, { error: 'NPC Parallel 内部宿主错误' });
        else response.destroy();
        // Deliberately do not log request bodies, story text, endpoint URLs, or credentials.
        void error;
      });
    });
    this.#server.requestTimeout = 30_000;
    this.#server.headersTimeout = 10_000;
    await new Promise<void>((resolveListen, rejectListen) => {
      this.#server!.once('error', rejectListen);
      this.#server!.listen(0, '127.0.0.1', resolveListen);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('NPC Parallel internal server did not bind a TCP port');
    this.#origin = `http://127.0.0.1:${address.port}`;

    if (!this.#browser) {
      const binary = process.env.LIYUAN_NPC_PARALLEL_BROWSER_EXECUTABLE
        ?? process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE
        ?? (existsSync(join(this.options.assetsCwd, '.liyuan-database-plugin/browser/headless_shell')) ? join(this.options.assetsCwd, '.liyuan-database-plugin/browser/headless_shell') : undefined);
      const libs = process.env.LIYUAN_NPC_PARALLEL_BROWSER_LIBS
        ?? process.env.LIYUAN_DATABASE_BROWSER_LIBS
        ?? process.env.LD_LIBRARY_PATH
        ?? join(this.options.assetsCwd, '.liyuan-database-plugin/browser-libs/lib64');
      this.#browser = await chromium.launch({
        headless: true,
        ...(binary ? { executablePath: binary } : {}),
        env: { ...process.env, LD_LIBRARY_PATH: libs },
        args: process.getuid?.() === 0 ? ['--no-sandbox'] : [],
      });
    }
    // A fresh BrowserContext per source task keeps storage/state isolated while reusing the verified local browser process.
    this.#context = await this.#browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
    const allowed = new Set([
      '/npc-parallel-host.html', '/npc-parallel/host.js', '/npc-parallel/host.css', '/npc-parallel/script.js', '/npc-parallel/scripts/extensions.js',
      '/npc-parallel/vendor/jquery.js', '/npc-parallel/vendor/jquery-ui.js', '/npc-parallel/vendor/jquery-touch-punch.js', '/npc-parallel/vendor/toastr.js',
      '/npc-parallel/scripts/extensions/third-party/npc-parallel/manifest.json',
      ...pluginAssets.map(asset => `/npc-parallel/scripts/extensions/third-party/npc-parallel/${asset}`),
      '/api/npc-parallel/context', '/__npc-parallel-job/generate',
    ]);
    await this.#context.route('**/*', route => {
      let url: URL;
      try { url = new URL(route.request().url()); } catch { return route.abort('blockedbyclient'); }
      let path: string;
      try { path = decodeURIComponent(url.pathname); } catch { return route.abort('blockedbyclient'); }
      if (url.origin !== this.#origin || !allowed.has(path)) return route.abort('blockedbyclient');
      return route.continue();
    });
    this.#page = await this.#context.newPage();
    this.#page.setDefaultTimeout(15_000);
    this.#page.setDefaultNavigationTimeout(20_000);
    const browserErrors: string[] = [];
    this.#page.on('pageerror', error => browserErrors.push(error.message.slice(0, 250)));
    this.#page.on('console', message => { if (message.type() === 'error' && browserErrors.length < 8) browserErrors.push(message.text().slice(0, 250)); });
    await this.#page.goto(`${this.#origin}/npc-parallel-host.html?view=runtime`, { waitUntil: 'domcontentloaded' });
    try {
      await npcWaitForPage(() => this.#page!.evaluate(() => (window as any).LiyuanNpcParallel?.ready?.() === true), 25_000, '原版页面未就绪', job.signal);
    } catch (waitError) {
      job.signal.throwIfAborted();
      const message = await this.#page.locator('#status').textContent().catch(() => '原版宿主无状态');
      const diag = await this.#page.evaluate(() => ({ ready: typeof (window as any).LiyuanNpcParallel?.ready, readyValue: (window as any).LiyuanNpcParallel?.ready?.(), host: !!(window as any).LiyuanNpcParallelHost, hostReady: (window as any).LiyuanNpcParallelHost?.ready, banner: document.getElementById('npcp-host-message')?.textContent, fab: !!document.getElementById('npcp_fab'), run: !!document.getElementById('npcp_run'), scripts: [...document.scripts].map(script => script.src).filter(Boolean) })).catch(() => null);
      const pageError = browserErrors.length ? `（浏览器错误：${browserErrors[0]}）` : '';
      const diagnostic = diag ? `；host=${diag.host}, ready=${diag.ready}, scripts=${diag.scripts.length}` : '';
      throw new Error(`NPC Parallel 原版页面未就绪：${String(message ?? '').slice(0, 300)}；等待错误=${String((waitError as Error)?.message ?? waitError).slice(0, 180)}${pageError}${diagnostic}${diag ? `; hostReady=${diag.hostReady}, readyValue=${diag.readyValue}, banner=${String(diag.banner ?? '').slice(0, 120)}, fab=${diag.fab}, run=${diag.run}` : ''}`);
    }
    job.assertBound();
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse, candidate: NpcParallelCandidate, bootstrap: Record<string, unknown>, job: {
    chat: NpcParallelChatMessage[]; sourceIndex: number; worldbooks: NpcParallelRunInput['worldbooks']; roster: NpcParallelNpc[];
    jobToken: string; managedGenerate: (request: NpcParallelGenerateRequest, signal?: AbortSignal) => Promise<string>; assertBound: () => void;
  }): Promise<void> {
    const url = new URL(request.url ?? '/', this.#origin);
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const origin = request.headers.origin;
    if (origin && origin !== this.#origin) return this.#reply(response, 403, { error: '外部来源被拒绝' });
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      if (origin !== this.#origin) return this.#reply(response, 403, { error: '写请求必须为同源' });
    }
    if (url.pathname === '/npc-parallel-host.html' && ['GET', 'HEAD'].includes(request.method ?? '')) {
      return this.#replyBytes(response, 200, 'text/html; charset=utf-8', readFileSync(join(this.options.assetsCwd, 'web/public/npc-parallel-host.html')));
    }
    const hostAsset = ASSET_FILES[url.pathname];
    if (hostAsset && ['GET', 'HEAD'].includes(request.method ?? '')) {
      return this.#replyBytes(response, 200, MIME[hostAsset.endsWith('.css') ? '.css' : '.js'], readFileSync(join(this.options.assetsCwd, hostAsset)));
    }
    const vendorName = VENDOR_NAMES[url.pathname];
    if (vendorName && ['GET', 'HEAD'].includes(request.method ?? '')) {
      const file = tavernVendorAsset(this.options.assetsCwd, vendorName);
      if (!file) return this.#reply(response, 503, { error: `缺少哈希校验后的真实酒馆依赖：${vendorName}` });
      return this.#replyBytes(response, 200, 'text/javascript; charset=utf-8', readFileSync(file));
    }
    if (url.pathname === '/npc-parallel/scripts/extensions/third-party/npc-parallel/manifest.json' && ['GET', 'HEAD'].includes(request.method ?? '')) {
      const file = this.options.sources.resolveAsset('manifest.json', candidate);
      if (!file) return this.#reply(response, 404, { error: '原版manifest缺失' });
      return this.#replyBytes(response, 200, 'application/json; charset=utf-8', readFileSync(file));
    }
    const pluginRoot = '/npc-parallel/scripts/extensions/third-party/npc-parallel/';
    if (url.pathname.startsWith(pluginRoot) && ['GET', 'HEAD'].includes(request.method ?? '') && url.pathname !== `${pluginRoot}manifest.json`) {
      let rel: string;
      try { rel = safeAssetPath(decodeURIComponent(url.pathname.slice(pluginRoot.length))); }
      catch { return this.#reply(response, 400, { error: '原版资源路径无效' }); }
      if (!declaredPluginAssets(candidate.manifest).includes(rel)) return this.#reply(response, 404, { error: '原版资源未由manifest声明' });
      const file = this.options.sources.resolveAsset(rel, candidate);
      if (!file) return this.#reply(response, 404, { error: '原版manifest声明资源缺失或未获SourceLike允许' });
      return this.#replyBytes(response, 200, pluginAssetMime(rel), readFileSync(file));
    }
    if (url.pathname === '/api/npc-parallel/context' && request.method === 'GET') {
      const body = safeJson(bootstrap);
      if (Buffer.byteLength(body) > MAX_CONTEXT_BYTES) return this.#reply(response, 413, { error: '隔离上下文超过宿主容量限制' });
      return this.#replyBytes(response, 200, 'application/json; charset=utf-8', Buffer.from(body));
    }
    if (url.pathname === '/__npc-parallel-job/generate' && request.method === 'POST') {
      if (type !== 'application/json') return this.#reply(response, 415, { error: '受管生成只接受JSON' });
      if (request.headers['x-liyuan-npc-parallel-job'] !== job.jobToken) return this.#reply(response, 403, { error: '隔离任务令牌无效' });
      if (!origin || origin !== this.#origin) return this.#reply(response, 403, { error: '受管生成仅接受隔离页面同源请求' });
      const bytes = await this.#readBody(request, MAX_BODY_BYTES);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return this.#reply(response, 400, { error: '受管生成请求不是合法JSON' }); }
      if (!isRecord(parsed)) return this.#reply(response, 400, { error: '受管生成请求结构无效' });
      // Accept either the host quiet-prompt payload or original Tavern proxy fields.
      const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
      if (!messages || !messages.length || messages.length > MAX_MESSAGES) return this.#reply(response, 400, { error: '受管生成 messages 无效' });
      const normalized: NpcParallelMessage[] = [];
      for (const message of messages) {
        if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role)) || typeof message.content !== 'string') {
          return this.#reply(response, 400, { error: '受管生成遇到未知消息结构' });
        }
        normalized.push({ role: message.role as NpcParallelRole, content: message.content });
      }
      const maxTokens = Number(parsed.maxTokens ?? parsed.max_tokens);
      if (!Number.isSafeInteger(Math.floor(maxTokens)) || maxTokens < 1 || maxTokens > 100000) return this.#reply(response, 400, { error: '受管生成 maxTokens 无效' });
      const temperature = parsed.temperature == null ? undefined : Number(parsed.temperature);
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return this.#reply(response, 400, { error: '受管生成 temperature 无效' });
      job.assertBound();
      const controller = new AbortController();
      const onAborted = () => controller.abort(new DOMException('NPC Parallel request disconnected', 'AbortError'));
      request.once('aborted', onAborted);
      response.once('close', () => { if (!response.writableEnded) onAborted(); });
      try {
        const signal = AbortSignal.any([this.#abort!.signal, controller.signal]);
        const content = await job.managedGenerate({
          messages: normalized,
          maxTokens: Math.floor(maxTokens),
          ...(temperature === undefined ? {} : { temperature }),
          purpose: typeof parsed.purpose === 'string' ? parsed.purpose : 'npc-parallel managed generation',
        }, signal);
        if (signal.aborted) throw signal.reason;
        const wantsStream = parsed.stream === true || String(request.headers.accept ?? '').includes('text/event-stream');
        if (wantsStream) {
          const chunks = [...content].map((part, index, all) => `data: ${JSON.stringify({ choices: [{ delta: { content: part }, finish_reason: index === all.length - 1 ? 'stop' : null }] })}\n\n`).join('');
          return this.#replyBytes(response, 200, 'text/event-stream; charset=utf-8', Buffer.from(`${chunks}data: [DONE]\n\n`), { 'cache-control': 'no-store', connection: 'close' });
        }
        return this.#reply(response, 200, { content });
      } catch (error) {
        const aborted = controller.signal.aborted || this.#abort?.signal.aborted;
        return this.#reply(response, aborted ? 499 : 502, {
          code: aborted ? 'aborted' : 'managed_generation_failed',
          error: aborted ? '受管任务已取消' : '受管模型请求失败',
        });
      }
    }
    // Explicitly reject the parent app model API and all arbitrary routes in the isolated job server.
    if (url.pathname === '/api/npc-parallel/generate' || url.pathname === '/api/backends/chat-completions/generate') {
      return this.#reply(response, 403, { error: '原版插件的公开模型接口已禁用；仅允许内部受管jobserver' });
    }
    return this.#reply(response, 404, { error: 'NPC Parallel internal route not found' });
  }


  #asset(rel: string, candidate: NpcParallelCandidate): Buffer {
    const file = this.options.sources.resolveAsset(rel, candidate);
    if (!file || !existsSync(file) || !lstatSync(file).isFile()) throw new Error(`NPC Parallel 原版资源不存在或不是普通文件：${rel}`);
    return readFileSync(file);
  }
  #reply(response: ServerResponse, status: number, payload: unknown): void {
    this.#replyBytes(response, status, 'application/json; charset=utf-8', Buffer.from(safeJson(payload)));
  }
  #replyBytes(response: ServerResponse, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
    response.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'",
      ...extra,
    });
    if (response.req?.method === 'HEAD') response.end(); else response.end(body);
  }
  #readBody(request: IncomingMessage, max: number): Promise<Buffer> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', chunk => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > max) { rejectBody(new Error('request body too large')); request.destroy(); return; }
        chunks.push(value);
      });
      request.once('end', () => resolveBody(Buffer.concat(chunks)));
      request.once('error', rejectBody);
    });
  }
  async #disposeRealm(): Promise<void> {
    const context = this.#context;
    this.#context = null; this.#page = null;
    if (context) await context.close().catch(() => undefined);
    if (this.#server?.listening) {
      this.#server.closeAllConnections();
      await new Promise<void>(resolveClose => this.#server!.close(() => resolveClose()));
    }
    this.#server = null;
    this.#origin = '';
  }

  async #disposeRuntime(): Promise<void> {
    await this.#disposeRealm();
    const browser = this.#browser;
    this.#browser = null;
    if (browser) await browser.close().catch(() => undefined);
  }
}
