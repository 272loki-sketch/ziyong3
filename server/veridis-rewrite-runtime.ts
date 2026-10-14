/** Detached original-engine host. No upstream module/prompt/rule engine is copied or patched here. */
import { Worker } from 'node:worker_threads';
import { lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute, relative, sep } from 'node:path';
import { abortable } from '../src/async-abort.ts';
import type { VeridisRewriteCandidate } from './veridis-rewrite-source.ts';

export interface VeridisRewriteSourceLike {
  active(): VeridisRewriteCandidate | null;
  resolveAsset(relativePath: string, candidate?: VeridisRewriteCandidate): string | null;
}
export interface VeridisRewriteGenerateRequest {
  messages: { role: string; content: string }[];
  maxTokens: number;
  temperature?: number;
}
export interface VeridisRewriteRunInput {
  sourceEntryId: string;
  authorDraft: string;
  narrative: string;
  settings?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Same throwing source/branch guard as other hosts; false also rejects stale work. */
  guard: () => void | boolean | Promise<void | boolean>;
  generate: (request: VeridisRewriteGenerateRequest, signal?: AbortSignal) => Promise<string>;
}
export interface VeridisRewriteRunResult {
  text: string;
  changed: boolean;
  calls: number;
  errors: string[];
  version: string;
  commit: string;
  settings?: Record<string, unknown>;
  hits?: number;
  skipped?: boolean;
  skipReason?: string;
  /** Native output, or a safe projection of the original engine's parsed AI targets. */
  projectionMode?: 'native' | 'ai-targets-only';
}
/** Host-owned optional starting rules only; upstream defaults supply the original global prompt. */
export function defaultVeridisHostSettings(): Record<string, unknown> {
  return {
    liyuanDefaultsVersion: 1,
    rules: [{ id: 'liyuan-rewrite-cliches-v1', name: '梨园：有限套话润色（可禁用/修改）', enabled: true, subRules: [{
      id: 'liyuan-cliches-v1', enabled: true, mode: 'text', rewriteMode: 'ai',
      targets: ['不易察觉', '一抹复杂', '仿佛在诉说', '眼底闪过', '嘴角勾起一抹', '不由自主'], replacements: [],
      aiPromptTemplate: '仅在不改变原意、人物关系、情节事实和叙事视角的前提下，替换命中的惯常套话为自然克制的表达。不得增加动作、心理、隐喻、台词或新事实；不要改动原引号、Markdown或结构。必要时原样返回。',
    }]}],
    aiRewrite: { enabled: true, autoTriggerEnabled: true },
  };
}
interface Range { start: number; end: number }
interface Target extends Range { id: string; text: string }
interface WorkerResult { text: string; settings?: Record<string, unknown>; hits: number; targets?: Target[]; replacements?: Record<string, string>; errors: string[]; skipped?: boolean; skipReason?: string }
const MAX_CALLS = 8;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const MAX_RUN_MS = 15 * 60 * 1000;
const ENGINE_PATHS = ['src/host/appContext.js', 'src/settings/defaults.js', 'src/aiRewrite/runtime.js', 'src/aiRewrite/response.js'];
const SAFE_WORKER_ERROR_NAMES = ['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError'] as const;
const SAFE_WORKER_ERROR_CODES = ['ERR_ACCESS_DENIED'] as const;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const credentialKey = /^(?:api[_-]?key|key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|oauth)$/i;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cloneSettings(settings: Record<string, unknown> | undefined): { publicSettings: Record<string, unknown> | undefined; secrets: string[] } {
  if (settings === undefined) return { publicSettings: undefined, secrets: [] };
  if (!record(settings)) throw new Error('Veridis Rewrite 原设置必须是 JSON 对象');
  const secrets = new Set<string>();
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('Veridis Rewrite 原设置结构过深');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Veridis Rewrite 原设置只接受普通 JSON 数据');
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (dangerous.has(key)) throw new Error('Veridis Rewrite 原设置含危险 JSON 键');
      if (credentialKey.test(key)) {
        if (typeof child === 'string' && child) secrets.add(child);
        continue;
      }
      result[key] = clean(child, depth + 1);
    }
    return result;
  };
  const publicSettings = clean(settings) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(publicSettings)) > MAX_SETTINGS_BYTES) throw new Error('Veridis Rewrite 原设置超出宿主预算');
  return { publicSettings, secrets: [...secrets] };
}
function narrativeRanges(author: string, narrative: string): Range[] {
  const unique = (piece: string): Range | null => {
    if (!piece) return null;
    const start = author.indexOf(piece);
    if (start < 0 || author.indexOf(piece, start + 1) >= 0) return null;
    return { start, end: start + piece.length };
  };
  const full = unique(narrative);
  if (full) return [full];
  // Canonical narrative can omit wrappers. Admit only exact unique paragraphs;
  // never guess offsets or use normalized/rewritten text to claim source ranges.
  return narrative.split(/\n\s*\n/).map(piece => unique(piece.trim())).filter((item): item is Range => item !== null);
}
function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const expressions = [
    /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g,
    /<!--[\s\S]*?-->/g,
    /`[^`\n]*`/g,
    /<(UpdateVariable|JSONPatch|initvar|options|choices|choice|option|status|stat_data|tableEdit|horae|horaeevent|think|thinking|html|head|body|script|style|iframe|details|summary|div|span|p|a|h[1-6]|section|article|table|thead|tbody|tr|td|th|ul|ol|li|form|button|select|textarea|code|pre|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    /<[^>\n]+>/g,
    /!?(?:\[[^\]\n]*\])\([^\)\n]*\)/g,
  ];
  for (const expression of expressions) for (const match of text.matchAll(expression)) ranges.push({ start: match.index!, end: match.index! + match[0].length });
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}
/**
 * Compose only original-engine target receipts, never its unrestricted full-message
 * Program postpass. The engine still owns target detection, prompts, parsing and
 * AI acceptance. The host owns the byte-exact complement of the display projection.
 */
function targetProjection(original: string, result: WorkerResult, allowed: Range[], protectedSpans: Range[]): string {
  if (!Array.isArray(result.targets) || !record(result.replacements) || !result.targets.length) throw new Error('原改写引擎缺少目标回执，拒绝显示投影');
  let projected = original;
  const targets = [...result.targets].sort((a, b) => b.start - a.start);
  const ids = new Set<string>();
  let next = original.length;
  for (const target of targets) {
    if (!target || typeof target.id !== 'string' || !target.id || ids.has(target.id) || !Number.isInteger(target.start) || !Number.isInteger(target.end) || target.start < 0 || target.end > next || target.start >= target.end ||
        target.text !== original.slice(target.start, target.end) || !allowed.some(span => target.start >= span.start && target.end <= span.end) ||
        protectedSpans.some(span => target.start < span.end && target.end > span.start)) throw new Error('原改写目标越出已确认正文或碰触原格式，拒绝显示投影');
    ids.add(target.id);
    const replacement = Object.hasOwn(result.replacements, target.id) ? result.replacements[target.id] : undefined;
    if (typeof replacement !== 'string' || /<[^>\n]+>|```|~~~|\r|\n/.test(replacement)) throw new Error('改写结果包含新的结构/格式，拒绝显示投影');
    const formatTokens = (text: string) => [...text.matchAll(/\*\*|__|~~|\*|[“”‘’「」『』"]/g)].map(match => match[0]);
    if (JSON.stringify(formatTokens(target.text)) !== JSON.stringify(formatTokens(replacement))) throw new Error('改写结果改变了原 Markdown 或引号结构，拒绝显示投影');
    projected = projected.slice(0, target.start) + replacement + projected.slice(target.end);
    next = target.start;
  }
  if (Buffer.byteLength(projected) > MAX_TEXT_BYTES) throw new Error('改写显示投影超出宿主预算');
  return projected;
}

/** Worker glue only. Every target, template, response map and composition is upstream-owned. */
const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const safeErrorNames = new Set(${JSON.stringify(SAFE_WORKER_ERROR_NAMES)});
const safeErrorCodes = new Set(${JSON.stringify(SAFE_WORKER_ERROR_CODES)});
const pending = new Map();
let sequence = 0;
parentPort.on('message', message => {
  const task = pending.get(message.id);
  if (!task) return;
  pending.delete(message.id);
  if (message.error) task.reject(Object.assign(new Error(message.error), message.status ? { status: message.status } : {}));
  else task.resolve(message.text);
});
// No original API keys or environment are provided; original network calls must
// go through the managed TavernHelper bridge. UI/statistics callbacks are inert.
globalThis.fetch = () => Promise.reject(new Error('未支持的原插件网络 API'));
globalThis.WebSocket = class { constructor() { throw new Error('未支持的原插件网络 API'); } };
globalThis.TavernHelper = {
  generateRaw: async config => {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    parentPort.postMessage({ type: 'generate', id, generationId: config.generation_id, request: {
      messages: config.ordered_prompts,
      maxTokens: Number.isFinite(Number(config.custom_api?.max_tokens)) ? Number(config.custom_api.max_tokens) : 4096,
      temperature: config.custom_api?.temperature,
    }});
    const response = await result;
    // Never infer group identity from template/example strings. The original
    // runtime validates exact per-group IDs itself; retain only upstream-parsed
    // values referring to actual prepared targets for complement verification.
    const returned = responseModule.parseAiRewriteResponseObject(response);
    const returnedIds = new Set(Object.keys(returned));
    const parsed = responseModule.parseAiResponse(response, new Map(prepared.items.filter(item => returnedIds.has(item.id)).map(item => [item.id, item])));
    parsed.forEach((text, key) => accepted[key] = text);
    return response;
  },
  stopGenerationById: generationId => parentPort.postMessage({ type: 'stop', generationId }),
};
let responseModule, prepared;
const accepted = Object.create(null);
(async () => {
  const defaults = await import(workerData.modules.defaults);
  const host = await import(workerData.modules.host);
  const engine = await import(workerData.modules.engine);
  responseModule = await import(workerData.modules.response);
  if (typeof engine.buildAiRewriteTaskCheck !== 'function' || typeof engine.runAiRewriteForMessageNow !== 'function' || typeof responseModule.parseAiResponse !== 'function' || typeof responseModule.parseAiRewriteResponseObject !== 'function' || typeof host.initAppContext !== 'function') throw new Error('不兼容的原改写模块 API');
  const settings = { ...structuredClone(defaults.defaultSettings), ...(workerData.settings || {}) };
  if (!Object.hasOwn(workerData.settings || {}, 'rules')) settings.rules = workerData.defaultRules;
  const originalAi = { ...structuredClone(defaults.defaultAiRewriteSettings), ...(workerData.settings?.aiRewrite || {}) };
  if (!Object.hasOwn(workerData.settings?.aiRewrite || {}, 'xmlScopeTag')) originalAi.xmlScopeTag = workerData.authorDraft.includes('<content>') ? defaults.defaultAiRewriteSettings.xmlScopeTag : '';
  settings.aiRewrite = originalAi;
  const persistedSettings = structuredClone(settings);
  const runtimeSettings = { ...settings, logLevel: 0, aiRewrite: { ...originalAi, baseUrl: 'https://managed.invalid', apiKey: 'host-managed-only', model: 'gemini-3.8-flash' } };
  const message = { is_user: false, is_system: false, name: 'Author', mes: workerData.authorDraft, extra: {}, __liyuanEntryId: workerData.sourceEntryId };
  const chat = [message];
  host.initAppContext({
    extension_settings: { [defaults.extensionName]: runtimeSettings }, chat,
    saveSettingsDebounced: () => {}, saveChat: async () => {},
    getSillyTavernContext: () => ({ chat, chatId: workerData.sourceEntryId, chatMetadata: {} }),
  });
  if (typeof engine.resetAiRewriteRuntimeState === 'function') engine.resetAiRewriteRuntimeState('isolated-host');
  if (settings.enabled === false || originalAi.autoTriggerEnabled === false) {
    parentPort.postMessage({ type: 'done', result: { text: message.mes, hits: 0, settings: persistedSettings, errors: [], skipped: true, skipReason: '原插件或自动 AI 改写已关闭' } });
    return;
  }
  const checked = engine.buildAiRewriteTaskCheck({ messageId: 0 }, { manual: true });
  if (!checked.task) {
    const reason = String(checked.reason || '未命中可改写规则');
    parentPort.postMessage({ type: 'done', result: { text: message.mes, hits: 0, settings: persistedSettings, errors: [], skipped: true, skipReason: reason } });
    return;
  }
  const items = checked.task.items.filter(item => workerData.allowed.some(span => item.start >= span.start && item.end <= span.end) &&
    !workerData.protected.some(span => item.start < span.end && item.end > span.start));
  if (!items.length) {
    parentPort.postMessage({ type: 'done', result: { text: message.mes, hits: 0, settings: persistedSettings, errors: [], skipped: true, skipReason: '命中项均位于原格式或无法确认的正文范围' } });
    return;
  }
  prepared = { ...checked.task, items };
  const result = await engine.runAiRewriteForMessageNow({ messageId: 0 }, { manual: true, preparedTask: prepared });
  const success = result?.status === 'applied' || result?.status === 'no-change';
  parentPort.postMessage({ type: 'done', result: {
    text: success ? message.mes : workerData.authorDraft,
    hits: items.length, settings: persistedSettings,
    targets: items.map(item => ({ id: item.id, start: item.start, end: item.end, text: workerData.authorDraft.slice(item.start, item.end) })),
    replacements: accepted, errors: success ? [] : ['原改写引擎未完成有效 AI 改写；保留完整原稿'],
  }});
})().catch(error => {
  // Preserve a safe machine-readable cause for host diagnostics without
  // forwarding exception text, paths, plugin data, or credentials.
  let errorName, errorCode;
  try {
    if (typeof error?.name === 'string' && safeErrorNames.has(error.name)) errorName = error.name;
    if (typeof error?.code === 'string' && safeErrorCodes.has(error.code)) errorCode = error.code;
  } catch { /* hostile custom error accessors are not diagnostic data */ }
  parentPort.postMessage({ type: 'fatal', errorName, errorCode });
});
`;

export class VeridisRewriteRuntime {
  readonly #sources: VeridisRewriteSourceLike;
  readonly #operations = new Set<AbortController>();
  #closed = false;
  constructor(options: { assetsCwd: string; sources: VeridisRewriteSourceLike });
  constructor(cwd: string, sources: VeridisRewriteSourceLike);
  constructor(options: string | { assetsCwd: string; sources: VeridisRewriteSourceLike }, sources?: VeridisRewriteSourceLike) {
    const selected = typeof options === 'string' ? sources : options.sources;
    if (!selected) throw new Error('Veridis Rewrite 缺少原版来源管理器');
    this.#sources = selected;
  }
  busy(): boolean { return this.#operations.size > 0; }
  async run(input: VeridisRewriteRunInput): Promise<VeridisRewriteRunResult> {
    if (this.#closed) throw new Error('Veridis Rewrite 宿主已关闭');
    if (!input || typeof input.sourceEntryId !== 'string' || !input.sourceEntryId || typeof input.authorDraft !== 'string' || typeof input.narrative !== 'string' ||
        typeof input.guard !== 'function' || typeof input.generate !== 'function') throw new Error('Veridis Rewrite 缺少绑定来源、原稿或受管生成接口');
    if (Buffer.byteLength(input.authorDraft) > MAX_TEXT_BYTES || Buffer.byteLength(input.narrative) > MAX_TEXT_BYTES) throw new Error('Veridis Rewrite 原稿超出宿主预算');
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Veridis Rewrite 已取消'));
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.#operations.add(controller);
    let worker: Worker | undefined;
    let calls = 0;
    const requests = new Map<number, { generationId: string; controller: AbortController }>();
    const ensureCurrent = async () => {
      if (controller.signal.aborted || this.#closed) throw new Error('Veridis Rewrite 已取消或关闭');
      if (await input.guard() === false) throw new Error('Veridis Rewrite 正文来源已过期');
      if (controller.signal.aborted || this.#closed) throw new Error('Veridis Rewrite 已取消或关闭');
    };
    try {
      await ensureCurrent();
      const candidate = this.#sources.active();
      if (!candidate) throw new Error('Veridis Rewrite 尚未安装或原版完整性失败');
      // A valid cache may be reached through a platform alias (macOS /var ->
      // /private/var). Permission flags and file: URLs must use the same
      // canonical path or Node can deny the module imports in the Worker.
      const rootStat = lstatSync(candidate.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Veridis Rewrite 候选根目录不是安全的普通目录');
      const assetsRoot = realpathSync(candidate.root);
      const modules = ENGINE_PATHS.map(path => {
        const file = this.#sources.resolveAsset(path, candidate);
        if (!file) throw new Error(`Veridis Rewrite 缺少已验证的原模块：${path}`);
        const fileStat = lstatSync(file);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`Veridis Rewrite 原模块不是安全的普通文件：${path}`);
        const canonicalFile = realpathSync(file);
        const relativeFile = relative(assetsRoot, canonicalFile);
        if (!relativeFile || relativeFile === '..' || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
          throw new Error(`Veridis Rewrite 原模块越出已验证资产根目录：${path}`);
        }
        return pathToFileURL(canonicalFile).href;
      });
      const safeSettings = cloneSettings(input.settings);
      const allowed = narrativeRanges(input.authorDraft, input.narrative);
      const protectedSpans = protectedRanges(input.authorDraft);
      const base = { text: input.authorDraft, changed: false, calls, errors: [], version: candidate.version, commit: candidate.commit };
      if (!allowed.length) return { ...base, settings: input.settings ? structuredClone(input.settings) : undefined, skipped: true, skipReason: '无法精确绑定原稿中的正文范围', hits: 0 };
      await ensureCurrent();
      worker = new Worker(WORKER, {
        eval: true, env: {}, stdout: true, stderr: true,
        // Only private verified assets may be read. No filesystem writes, subprocesses,
        // addon loading or nested workers are granted to upstream modules.
        execArgv: ['--permission', `--allow-fs-read=${assetsRoot}${sep}`],
        resourceLimits: { maxOldGenerationSizeMb: 192 },
        workerData: { sourceEntryId: input.sourceEntryId, authorDraft: input.authorDraft, settings: safeSettings.publicSettings, defaultRules: defaultVeridisHostSettings().rules, allowed, protected: protectedSpans,
          modules: { host: modules[0], defaults: modules[1], engine: modules[2], response: modules[3] } },
      });
      // Upstream logs must not expose private prompts, text, or settings to the service console.
      worker.stdout?.resume(); worker.stderr?.resume();
      const result = await abortable(new Promise<WorkerResult>((resolvePromise, reject) => {
        const timeout = setTimeout(() => { controller.abort(new Error('Veridis Rewrite 执行超时')); }, MAX_RUN_MS);
        timeout.unref();
        const finish = (work: () => void) => { clearTimeout(timeout); work(); };
        worker!.once('error', cause => finish(() => reject(new Error('原改写 Worker 失败，未提交显示投影', { cause }))));
        worker!.once('exit', () => finish(() => reject(new Error('原改写 Worker 已退出，未提交显示投影'))));
        worker!.on('message', (message: unknown) => {
          if (!record(message) || typeof message.type !== 'string') { finish(() => reject(new Error('原改写 Worker 返回未知协议'))); return; }
          if (message.type === 'done') { finish(() => resolvePromise(message.result as WorkerResult)); return; }
          if (message.type === 'fatal') {
            const safeName = (value: unknown) => typeof value === 'string' && (SAFE_WORKER_ERROR_NAMES as readonly string[]).includes(value) ? value : undefined;
            const safeCode = (value: unknown) => typeof value === 'string' && (SAFE_WORKER_ERROR_CODES as readonly string[]).includes(value) ? value : undefined;
            const details = [safeName(message.errorName), safeCode(message.errorCode)].filter((value): value is string => !!value);
            const cause = details.length ? new Error(`Worker ${details.join(' ')}`) : undefined;
            finish(() => reject(new Error('原改写模块初始化或执行失败，拒绝显示投影', cause ? { cause } : undefined)));
            return;
          }
          if (message.type === 'stop') {
            for (const task of requests.values()) if (task.generationId === message.generationId) task.controller.abort(new Error('原改写请求取消或超时'));
            return;
          }
          if (message.type !== 'generate') { finish(() => reject(new Error('原改写 Worker 请求未支持的 API'))); return; }
          const id = message.id;
          if (!Number.isSafeInteger(id) || requests.has(id as number)) { finish(() => reject(new Error('原改写 Worker 请求身份无效'))); return; }
          const callController = new AbortController();
          requests.set(id as number, { generationId: String(message.generationId || ''), controller: callController });
          void (async () => {
            try {
              await ensureCurrent();
              const request = message.request as VeridisRewriteGenerateRequest;
              if (!request || !Array.isArray(request.messages) || request.messages.length > 64 || request.messages.some(item => !item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') ||
                  !Number.isInteger(request.maxTokens) || request.maxTokens < 0 || request.maxTokens > 65536 || request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new Error('原改写 Worker 请求格式无效');
              const serialized = JSON.stringify(request);
              if (Buffer.byteLength(serialized) > MAX_TEXT_BYTES || safeSettings.secrets.some(secret => serialized.includes(secret))) throw new Error('原改写请求包含凭据或超出宿主预算');
              if (calls >= MAX_CALLS) throw new Error('Veridis Rewrite 单来源受管生成额度已用尽');
              calls++;
              const stop = () => callController.abort(new Error('Veridis Rewrite 已取消'));
              controller.signal.addEventListener('abort', stop, { once: true });
              try {
                const text = await abortable(input.generate(request, callController.signal), callController.signal);
                if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error('原改写受管返回超出宿主预算');
                await ensureCurrent();
                worker?.postMessage({ id, text });
              } finally { controller.signal.removeEventListener('abort', stop); }
            } catch {
              worker?.postMessage({ id, error: '受管改写请求失败或来源过期', status: calls >= MAX_CALLS ? 400 : undefined });
              if (controller.signal.aborted) finish(() => reject(new Error('Veridis Rewrite 已取消')));
            } finally { requests.delete(id as number); }
          })().catch(() => finish(() => reject(new Error('原改写请求桥接失败'))));
        });
      }), controller.signal);
      await ensureCurrent();
      const current = this.#sources.active();
      if (!current || current.commit !== candidate.commit || current.sha256 !== candidate.sha256 || ENGINE_PATHS.some(path => !this.#sources.resolveAsset(path, candidate))) throw new Error('原改写版本或字节已变化，拒绝迟到显示投影');
      if (!result || typeof result.text !== 'string' || !Array.isArray(result.errors) || result.errors.some(error => typeof error !== 'string') || !Number.isInteger(result.hits)) throw new Error('原改写 Worker 结果结构无效');
      const settings = { ...(result.settings ?? {}), ...(input.settings ?? {}), aiRewrite: { ...(record(result.settings?.aiRewrite) ? result.settings.aiRewrite : {}), ...(record(input.settings?.aiRewrite) ? input.settings.aiRewrite : {}) } };
      if (result.errors.length || result.skipped) return { ...base, calls, errors: result.errors, settings, hits: result.hits, ...(result.skipped ? { skipped: true, skipReason: result.skipReason } : {}) };
      const text = targetProjection(input.authorDraft, result, allowed, protectedSpans);
      return { ...base, text, changed: text !== input.authorDraft, calls, settings, hits: result.hits, projectionMode: text === result.text ? 'native' : 'ai-targets-only' };
    } finally {
      input.signal?.removeEventListener('abort', abort);
      controller.abort(new Error('Veridis Rewrite 任务结束'));
      for (const task of requests.values()) task.controller.abort(new Error('Veridis Rewrite 任务结束'));
      if (worker) await worker.terminate();
      this.#operations.delete(controller);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#operations) controller.abort(new Error('Veridis Rewrite 宿主关闭'));
  }
}
