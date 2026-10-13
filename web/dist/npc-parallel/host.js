const MODULE = 'npc_parallel';
const MAX_BOOTSTRAP_BYTES = 32 * 1024 * 1024;
const clone = value => value == null ? value : structuredClone(value);
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const hostMessage = document.getElementById('npcp-host-message');
const statusNode = document.getElementById('status');
const params = new URLSearchParams(location.search);
const mode = params.get('view') === 'runtime' ? 'runtime' : 'manager';
document.body.dataset.view = mode;
document.documentElement.lang = 'zh-CN';
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

function setStatus(message, failed = false) {
  const value = String(message || '');
  if (hostMessage) hostMessage.textContent = value;
  if (statusNode && failed) statusNode.textContent = value;
}
function deny(message) { return Promise.reject(new Error(message)); }
function memoryStorage() {
  const values = new Map();
  return Object.freeze({
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  });
}
try { Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage() }); } catch { /* Sandboxed browsers may expose a non-configurable storage object. */ }
try { Object.defineProperty(window, 'sessionStorage', { configurable: true, value: memoryStorage() }); } catch { /* Same-origin storage is not used by the host adapter. */ }

async function getBootstrap() {
  const response = await window.fetch('/api/npc-parallel/context', { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`读取众生侧写上下文失败（HTTP ${response.status}）`);
  const raw = await response.text();
  if (raw.length > MAX_BOOTSTRAP_BYTES) throw new Error('众生侧写上下文超过宿主容量限制');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('众生侧写上下文不是合法 JSON'); }
  if (!isRecord(value)) throw new Error('众生侧写上下文结构无效');
  return value;
}

function extractSettings(value) {
  const raw = isRecord(value.settings) ? value.settings : {};
  return isRecord(raw[MODULE]) ? clone(raw[MODULE]) : clone(raw);
}
function extractChatMetadata(value) {
  const raw = isRecord(value.metadata) ? clone(value.metadata) : {};
  if (isRecord(raw[MODULE])) return raw;
  if (Array.isArray(raw.npcs) || Array.isArray(raw.ignoredNpcs)) return { [MODULE]: raw };
  return raw;
}
function safePluginAsset(value, label) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\') || value.includes('?') || value.includes('#') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`原版manifest的${label}资源路径无效，已拒绝加载`);
  }
  return value;
}
function manifestAssets(manifest) {
  if (!isRecord(manifest)) throw new Error('原版manifest结构无效');
  if (manifest.requires !== undefined && (!Array.isArray(manifest.requires) || manifest.requires.length > 0)) throw new Error('原版manifest声明了当前宿主不支持的必需依赖');
  const paths = [safePluginAsset(manifest.js, 'js')];
  const css = safePluginAsset(manifest.css, 'css');
  if (css) paths.push(css);
  const raw = manifest.assets;
  if (raw !== undefined) {
    let declared;
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) declared = raw;
    else if (isRecord(raw)) declared = Object.values(raw).map(item => typeof item === 'string' ? item : isRecord(item) && typeof item.path === 'string' ? item.path : null);
    else throw new Error('原版manifest.assets格式不受支持');
    if (declared.some(item => typeof item !== 'string')) throw new Error('原版manifest.assets包含未知声明');
    for (const item of declared) paths.push(safePluginAsset(item, 'assets'));
  }
  return [...new Set(paths)];
}
function hideSecretsForRuntime(settings) {
  const result = clone(settings) ?? {};
  const redact = value => {
    if (!isRecord(value)) return;
    for (const key of ['apiKey', 'proxy_password', 'key', 'secret']) {
      if (typeof value[key] === 'string' && value[key]) value[key] = 'liyuan-managed-proxy';
    }
  };
  redact(result.customApi);
  for (const endpoint of result.customApi?.endpoints ?? []) redact(endpoint);
  return result;
}
function makeContext(bootstrap, settings, chatMetadata) {
  const chat = Array.isArray(bootstrap.chat) ? clone(bootstrap.chat) : [];
  const worldbooks = isRecord(bootstrap.worldbooks) ? clone(bootstrap.worldbooks) : {};
  const names = Object.keys(worldbooks);
  const ctx = {
    chat,
    chatMetadata,
    characters: [],
    characterId: undefined,
    name1: String(bootstrap.userName ?? '用户'),
    name2: String(bootstrap.characterName ?? '梨园角色'),
    getRequestHeaders: () => ({ 'content-type': 'application/json' }),
    getWorldInfoNames: () => [...names],
    async loadWorldInfo(name) {
      const key = String(name ?? '').trim();
      if (!Object.hasOwn(worldbooks, key)) throw new Error(`当前分支未提供世界书：${key}`);
      return clone(worldbooks[key]);
    },
    async getTokenCountAsync() { return 0; },
    async saveChat() { return window.LiyuanNpcParallelHost.saveChat(); },
    async saveMetadata() { return window.LiyuanNpcParallelHost.saveMetadata(); },
    updateMessageBlock() { throw new Error('梨园宿主不支持回写历史消息'); },
    messageFormatting() { throw new Error('梨园宿主不支持格式化并回写历史消息'); },
  };
  return ctx;
}

let bootstrap;
try {
  if (!window.jQuery || !window.toastr) throw new Error('未找到经过梨园完整性校验的 jQuery/toastr 依赖');
  bootstrap = await getBootstrap();
  const scope = isRecord(bootstrap.scope) ? bootstrap.scope : {};
  const scopeKey = String(bootstrap.scopeKey ?? '');
  const sourceEntryId = String(bootstrap.sourceEntryId ?? scope.sourceEntryId ?? '');
  const revision = Number(bootstrap.revision);
  const upstreamCommit = String(bootstrap.upstreamCommit ?? '');
  if (mode === 'manager' && (!scopeKey || !sourceEntryId || !Number.isSafeInteger(revision) || revision < 0 || !/^[0-9a-f]{40}$/i.test(upstreamCommit))) {
    throw new Error('管理页缺少 scopeKey/sourceEntryId/revision 绑定，拒绝初始化');
  }
  if (mode === 'runtime' && (!scope.sessionId || !scope.card || !sourceEntryId)) {
    throw new Error('任务页缺少会话/角色卡/正文来源绑定，拒绝初始化');
  }

  const settings = mode === 'runtime' ? hideSecretsForRuntime(extractSettings(bootstrap)) : extractSettings(bootstrap);
  if (mode === 'manager' && !Object.hasOwn(settings, 'theme')) settings.theme = params.get('theme') === 'dark' ? 'night' : 'day';
  const chatMetadata = extractChatMetadata(bootstrap);
  const pluginMeta = isRecord(chatMetadata[MODULE]) ? chatMetadata[MODULE] : {};
  if (Array.isArray(bootstrap.npcs)) pluginMeta.npcs = clone(bootstrap.npcs);
  if (mode === 'runtime') {
    // The branch-local roster is supplied for this invocation only; never seed a global roster from it.
    chatMetadata[MODULE] = pluginMeta;
    delete settings.npcs;
    delete settings.ignoredNpcs;
    settings.pickBeforeGen = false;
    settings.minGenTokens = 0;
    settings.delayMs = 0;
    settings.autoSyncDatabase = false;
    settings.autoDetectPresence = false;
  } else if (Array.isArray(bootstrap.npcs)) {
    chatMetadata[MODULE] = pluginMeta;
  }
  window.__npcParallelExtensionSettings = Object.create(null);
  window.__npcParallelExtensionSettings[MODULE] = settings;
  window.world_names = Object.keys(isRecord(bootstrap.worldbooks) ? bootstrap.worldbooks : {});
  window.selected_world_info = [];

  const context = makeContext(bootstrap, settings, chatMetadata);
  let currentRevision = revision;
  let pluginAssetPaths = new Set();
  const pluginAssetRoot = '/npc-parallel/scripts/extensions/third-party/npc-parallel/';
  let saveQueue = Promise.resolve();
  let saveTimer = null;
  let savePending = false;
  let saveFailure = null;
  const nativeFetch = window.fetch.bind(window);
  const sameOriginPath = input => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin) throw new Error('NPC Parallel 宿主禁止访问外部端点');
    return url.pathname;
  };
  const requestHeaders = headers => {
    const result = new Headers(headers ?? {});
    if (result.has('authorization') || result.has('x-api-key') || result.has('api-key')) {
      throw new Error('拒绝把自定义凭据交给NPC Parallel模型代理');
    }
    return result;
  };

  let runtimeTask = null;
  let originalEventSource = null;
  let originalEventTypes = null;
  async function runtimeSaveChat() {
    if (mode !== 'runtime') throw new Error('runtime save adapter used outside the isolated runner');
    if (runtimeTask) runtimeTask.saves++;
    // This is the exact public saveChat await reached by the unmodified upstream finally block.
    return undefined;
  }
  async function runtimeSaveMetadata() {
    if (mode !== 'runtime') return scheduleSave();
    return undefined;
  }

  async function saveStateNow() {
    if (mode !== 'manager') return;
    const body = {
      scopeKey,
      sourceEntryId,
      upstreamCommit,
      revision: currentRevision,
      settings: clone(window.__npcParallelExtensionSettings[MODULE]),
      metadata: clone(chatMetadata),
    };
    // Upstream controls may retain endpoint credentials in the UI, but the managed host never tests or sends them.
    const response = await nativeFetch('/api/npc-parallel/settings', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('梨园没有返回合法的NPC设置保存回执'); }
    if (!response.ok) throw new Error(String(result?.error ?? `NPC设置保存失败（HTTP ${response.status}）`));
    if (result.scopeKey !== scopeKey || result.sourceEntryId !== sourceEntryId || !Number.isSafeInteger(Number(result.revision)) || Number(result.revision) < currentRevision) {
      throw new Error('NPC设置保存回执的来源/revision不匹配');
    }
    currentRevision = Number(result.revision);
    setStatus('设置已按当前会话/角色卡/正文来源保存');
  }
  function scheduleSave() {
    if (mode !== 'manager') return Promise.resolve();
    savePending = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!savePending) return;
      savePending = false;
      saveQueue = saveQueue.then(saveStateNow).then(() => { saveFailure = null; }).catch(error => {
        saveFailure = error;
        setStatus(error?.message ?? String(error), true);
        try { window.toastr.error(error?.message ?? String(error), '梨园 · 众生侧写'); } catch { /* UI status above remains authoritative. */ }
      });
    }, 250);
    return Promise.resolve();
  }

  async function flushSettings() {
    if (mode !== 'manager') return;
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    await saveQueue;
    // Retry a failed snapshot only on an explicit flush, keeping the original CAS binding.
    while (savePending || saveFailure) {
      savePending = false;
      saveQueue = saveQueue.then(saveStateNow).then(() => { saveFailure = null; }).catch(error => {
        saveFailure = error;
        setStatus(error?.message ?? String(error), true);
      });
      await saveQueue;
      if (saveFailure) throw saveFailure;
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    }
  }

  window.LiyuanNpcParallelHost = {
    mode,
    bootstrap,
    settings,
    saveSettingsDebounced: scheduleSave,
    saveChat: mode === 'runtime' ? runtimeSaveChat : scheduleSave,
    saveMetadata: mode === 'runtime' ? runtimeSaveMetadata : scheduleSave,
    getContext: () => context,
    async generateQuietPrompt({ quietPrompt, responseLength }) {
      if (mode !== 'runtime') throw new Error('原设置页的手动模型调用已禁用；请使用梨园受管NPC岗位');
      return managedGenerate({ messages: [{ role: 'user', content: quietPrompt }], maxTokens: responseLength, purpose: 'npc-parallel quiet prompt' });
    },
    armRuntimeTask() {
      if (mode !== 'runtime' || !originalEventSource) throw new Error('隔离任务事件接口尚未就绪');
      const source = context.chat.find(message => String(message?.__liyuanEntryId ?? message?.entry_id ?? message?.message_id ?? '') === sourceEntryId);
      if (!source) throw new Error('隔离聊天中找不到绑定的正文来源');
      runtimeTask = { source, saves: 0, edited: 0, complete: false };
      return true;
    },
    emitReceived() {
      if (mode !== 'runtime' || !runtimeTask || !originalEventSource || !originalEventTypes) throw new Error('隔离任务尚未就绪');
      originalEventSource.emit(originalEventTypes.MESSAGE_RECEIVED, runtimeTask.source);
      return true;
    },
    snapshot() {
      const source = runtimeTask?.source ?? context.chat.find(message => String(message?.__liyuanEntryId ?? message?.entry_id ?? message?.message_id ?? '') === sourceEntryId);
      return {
        sourceMes: source?.mes,
        sourceExtra: clone(source?.extra ?? {}),
        metadata: clone(context.chatMetadata ?? {}),
        settings: clone(window.__npcParallelExtensionSettings[MODULE] ?? {}),
        status: document.getElementById('npcp_status')?.textContent ?? '',
        progress: document.getElementById('npcp_progress')?.textContent ?? '',
        completion: runtimeTask ? { saves: runtimeTask.saves, edited: runtimeTask.edited, ready: runtimeTask.complete } : null,
      };
    },
  };

  function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 2048) throw new Error('NPC Parallel 模型代理拒绝无效 messages');
    return messages.map(message => {
      if (!isRecord(message) || !['system', 'user', 'assistant'].includes(String(message.role))) throw new Error('NPC Parallel 模型代理遇到未知消息结构');
      if (typeof message.content !== 'string') throw new Error('NPC Parallel 模型代理不支持非文本消息');
      return { role: String(message.role), content: message.content };
    });
  }
  async function managedGenerate(request) {
    if (mode !== 'runtime') throw new Error('设置页不开放模型请求');
    const messages = validateMessages(request.messages);
    const payload = {
      messages,
      maxTokens: Math.min(100000, Math.max(1, Math.floor(Number(request.maxTokens) || 1))),
      ...(Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {}),
      ...(request.purpose ? { purpose: String(request.purpose).slice(0, 160) } : {}),
    };
    const response = await nativeFetch('/__npc-parallel-job/generate', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(bootstrap.jobToken ? { 'x-liyuan-npc-parallel-job': String(bootstrap.jobToken) } : {}) }, body: JSON.stringify(payload),
      signal: request.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(result?.error ?? `受管模型任务失败（HTTP ${response.status}）`));
      if (result?.code === 'aborted') error.name = 'AbortError';
      throw error;
    }
    if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('受管模型返回空内容');
    return result.content;
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    let path;
    try { path = sameOriginPath(input); requestHeaders(init.headers ?? (input instanceof Request ? input.headers : undefined)); }
    catch (error) { return deny(error?.message ?? 'NPC Parallel 请求被拒绝'); }
    const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (path === '/api/npc-parallel/generate') return deny('原版页面模型调用已由梨园明确禁用');
    if (mode === 'manager') {
      if (method === 'GET' && path.startsWith(pluginAssetRoot) && pluginAssetPaths.has(decodeURIComponent(path.slice(pluginAssetRoot.length)))) return originalFetch(input, init);
      return deny(`管理页不允许插件自行发起网络请求：${path}`);
    }
    if (path === '/api/backends/chat-completions/generate' && method === 'POST') {
      // Translate the unchanged plugin's public Tavern proxy request to a private loopback-only job route.
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (bootstrap.jobToken) headers.set('x-liyuan-npc-parallel-job', String(bootstrap.jobToken));
      return originalFetch(new URL('/__npc-parallel-job/generate', location.origin).href, { ...init, headers });
    }
    if (method === 'GET' && path.startsWith(pluginAssetRoot) && pluginAssetPaths.has(decodeURIComponent(path.slice(pluginAssetRoot.length)))) return originalFetch(input, init);
    if (path === '/__npc-parallel-job/generate' && method === 'POST') {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      if (bootstrap.jobToken) headers.set('x-liyuan-npc-parallel-job', String(bootstrap.jobToken));
      return originalFetch(input, { ...init, headers });
    }
    return deny(`NPC Parallel 运行器拒绝未知网络请求：${path}`);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    let path;
    try { path = sameOriginPath(url); } catch (error) { throw new DOMException(error?.message ?? '外部请求被拒绝', 'SecurityError'); }
    if (path === '/api/npc-parallel/generate') throw new DOMException('原版页面模型调用已禁用', 'NotSupportedError');
    if (mode === 'runtime' && path === '/api/backends/chat-completions/generate') return xhrOpen.call(this, method, '/__npc-parallel-job/generate', ...rest);
    if (mode === 'manager' && path.startsWith(pluginAssetRoot) && pluginAssetPaths.has(decodeURIComponent(path.slice(pluginAssetRoot.length)))) return xhrOpen.call(this, method, url, ...rest);
    if (mode === 'runtime' && path.startsWith(pluginAssetRoot) && pluginAssetPaths.has(decodeURIComponent(path.slice(pluginAssetRoot.length)))) return xhrOpen.call(this, method, url, ...rest);
    if (path.startsWith('/api/') || mode === 'manager') throw new DOMException('NPC Parallel 未知网络XHR API已禁用', 'NotSupportedError');
    return xhrOpen.call(this, method, url, ...rest);
  };
  window.WebSocket = class DisabledNpcParallelWebSocket { constructor() { throw new DOMException('NPC Parallel 宿主禁用WebSocket', 'NotSupportedError'); } };
  window.EventSource = class DisabledNpcParallelEventSource { constructor() { throw new DOMException('NPC Parallel 宿主禁用EventSource', 'NotSupportedError'); } };

  if (mode === 'manager') installManagerGuards();
  window.LiyuanNpcParallel = { ready: () => !!window.LiyuanNpcParallelHost?.ready, flush: flushSettings };
  setStatus(mode === 'runtime' ? '正在加载隔离的原版运行器…' : '正在加载原版设置…');

  if (!isRecord(bootstrap.manifest)) throw new Error('管理/运行上下文缺少经来源校验的原版manifest');
  const declaredAssets = manifestAssets(bootstrap.manifest);
  pluginAssetPaths = new Set(declaredAssets);
  const plugin = safePluginAsset(bootstrap.manifest.js, 'js');
  const pluginCss = safePluginAsset(bootstrap.manifest.css, 'css');
  if (!plugin) throw new Error('原版manifest没有声明js入口');
  if (pluginCss) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet'; stylesheet.id = 'npcp-upstream-stylesheet';
    stylesheet.href = new URL(encodeURI(pluginCss), `${location.origin}/npc-parallel/scripts/extensions/third-party/npc-parallel/`).href;
    await new Promise((resolve, reject) => { stylesheet.onload = resolve; stylesheet.onerror = () => reject(new Error('原版manifest声明的CSS资源加载失败')); document.head.append(stylesheet); });
  }
  const entryUrl = new URL(encodeURI(plugin), `${location.origin}/npc-parallel/scripts/extensions/third-party/npc-parallel/`).href;
  await import(entryUrl);
  await waitForOriginalReady();
  if (mode === 'manager') mountOriginalSettings();
  originalEventSource = window.__npcParallelEventSource;
  originalEventTypes = window.__npcParallelEventTypes;
  if (!originalEventSource || !originalEventTypes) throw new Error('上游事件适配器未导出');
  if (mode === 'runtime') {
    originalEventSource.on(originalEventTypes.MESSAGE_EDITED, message => {
      if (!runtimeTask || message !== runtimeTask.source || runtimeTask.saves < 1) return;
      runtimeTask.edited++;
      // MESSAGE_EDITED follows the successful awaited saveChat in the upstream finally block.
      // Resolve on the next event-loop turn so its remaining synchronous completion/status writes have run.
      setTimeout(() => { if (runtimeTask?.edited && runtimeTask.saves) runtimeTask.complete = true; }, 0);
    });
  }
  window.LiyuanNpcParallelHost.ready = true;
  if (mode === 'manager') {
    setStatus(`设置已就绪 · ${bootstrap.version ?? bootstrap.manifest?.version ?? '原版'} · 模型调用/原插件更新由梨园管理器负责`);
    window.parent.postMessage({ type: 'liyuan:npc-parallel-ready' }, location.origin);
  } else {
    setStatus('隔离运行器已就绪');
  }
} catch (error) {
  const message = String(error?.message ?? error ?? 'NPC Parallel 初始化失败').slice(0, 500);
  setStatus(`初始化失败：${message}`, true);
  window.LiyuanNpcParallel = { ready: false, error: message };
  window.parent.postMessage({ type: 'liyuan:npc-parallel-error', error: message }, location.origin);
  console.error('[npc-parallel-host]', message);
}

function installManagerGuards() {
  const disabledSelectors = [
    '#npcp_run', '#npcp_retry_failed', '#npcp_clear',
    '#npcp_test', '#npcp_ep_test_all', '.npcp-ep-test', '#npcp_api_add',
    '#npcp_upd_check', '#npcp_upd_install', '#npcp_update',
    '.npcp-pov-edit', '.npcp-pov-save', '.npcp-pov-del', '.npcp-pov-regen',
  ].join(',');
  const showBlocked = target => {
    const history = target.matches?.('.npcp-pov-edit,.npcp-pov-save,.npcp-pov-del,.npcp-pov-regen,#npcp_clear');
    const update = target.matches?.('#npcp_upd_check,#npcp_upd_install,#npcp_update');
    const message = history
      ? '历史侧写是鲜活世界已绑定工件；原管理页不允许改写/删除/重生成。'
      : update
        ? '上游原插件更新由梨园“众生侧写”来源管理器检查、验收与切换。'
        : '原版手动生成、端点测试与模型列表请求已禁用；模型由梨园 npcParallel 受管岗位提供。';
    setStatus(message);
    try { window.toastr.info(message, '梨园 · 众生侧写'); } catch { /* status remains visible */ }
  };
  const block = event => {
    const target = event.target?.closest?.(disabledSelectors);
    if (!target) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    showBlocked(target);
  };
  document.addEventListener('click', block, true);
  document.addEventListener('touchend', block, true);
  document.addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  const style = document.createElement('style');
  style.textContent = `${disabledSelectors}{pointer-events:auto!important;opacity:.55!important;filter:grayscale(.7)!important}`;
  document.head.append(style);
  const note = document.createElement('div');
  note.className = 'npcp-host-managed-note';
  note.textContent = '梨园宿主：人物/模板/世界书设置可编辑；手动模型生成、API连通/模型列表测试及历史侧写改写已禁用，来源更新由梨园管理器负责。自动回合会临时跳过原版“生成前选择”、将短正文阈值设为0、把延时设为0，并关闭世界书名单自动同步/新人自动识别；这些临时值不会覆盖此处保存的原设置，人物在场判断仍遵循“跳过在场”选项。';
  document.getElementById('npcp-host-help')?.append(note);
}

function waitForOriginalReady() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const check = () => {
      const ready = !!document.querySelector('#npcp_run,#npcp_fab,#npcp_floating');
      if (ready) { observer.disconnect(); resolve(); return; }
      if (Date.now() >= deadline) { observer.disconnect(); reject(new Error('原版 index.js 已导入，但设置根节点未就绪')); }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    check();
  });
}

/** Embed the original DOM rather than opening a second draggable modal inside an iframe. */
function mountOriginalSettings() {
  const panel = document.getElementById('npcp_floating');
  const canvas = document.getElementById('npcp-host-canvas');
  if (!panel || !canvas) throw new Error('原版设置画布未完整创建；没有用部分控件冒充原版就绪');
  panel.classList.add('open', 'npcp-host-inline');
  if (window.toastr?.options) Object.assign(window.toastr.options,{closeButton:true,preventDuplicates:true,positionClass:'toast-bottom-right',timeOut:3500,extendedTimeOut:1000,newestOnTop:true});
  const version = document.getElementById('npcp_ver');
  if (version && !version.textContent) version.textContent = `v${window.LiyuanNpcParallelHost.bootstrap.version ?? ''}`;
  // The original Tavern label says "main" even though all requests are bridged
  // to stepModels.npcParallel. Project the ACTUAL transport; never copy keys or
  // overwrite the user's stored custom API configuration to make the UI look right.
  const modeSelect=document.getElementById('npcp_api_mode');
  if(modeSelect){
    const model=window.LiyuanNpcParallelHost.bootstrap.model;
    const label=model?`梨园独立受管 API · ${model.provider} / ${model.id}`:'梨园独立受管 API · 未配置（不会借用正文）';
    modeSelect.replaceChildren(new Option(label,'liyuan-managed',true,true));
    modeSelect.disabled=true;
    modeSelect.title='与正文模型独立；端点和凭据来自连接面板，岗位为 npcParallel，不跟随正文切换。';
    const config=document.getElementById('npcp_api_cfg');if(config)config.hidden=true;
    const note=document.createElement('p');note.className='npcp-host-managed-note';note.textContent='实际调用 '+label+'。原酒馆的自定义端点设置不参与传输，无须重复填写 Key。修改独立侧写岗位请到连接／岗位模型设置；正文换模型不会改变此岗位。';
    modeSelect.parentElement?.append(note);
  }
  canvas.append(panel); // Move, never clone: original values, listeners, panes and API sections stay intact.
  const pinEmbeddedLayout = () => {
    for (const [property,value] of Object.entries({position:'relative',left:'auto',right:'auto',top:'auto',bottom:'auto',width:'100%',height:'100%','max-width':'none','max-height':'none',transform:'none','z-index':'auto'})) {
      if (panel.style.getPropertyValue(property)!==value || panel.style.getPropertyPriority(property)!=='important') panel.style.setProperty(property,value,'important');
    }
    for (const property of ['background','color']) if (panel.style.getPropertyValue(property)) panel.style.removeProperty(property);
  };
  pinEmbeddedLayout();
  const layoutObserver = new MutationObserver(pinEmbeddedLayout);
  layoutObserver.observe(panel,{attributes:true,attributeFilter:['style']});
  const syncTheme = () => { document.documentElement.dataset.theme = panel.dataset.npcpTheme === 'day' ? 'light' : 'dark'; };
  syncTheme();
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(panel, {attributes:true, attributeFilter:['data-npcp-theme']});
  for (const icon of panel.querySelectorAll('i.fa-solid,i.fa-regular')) icon.setAttribute('aria-hidden','true');
  const nav = panel.querySelector('.npcp-tabs');
  const tabs = [...(nav?.querySelectorAll('.npcp-tab') ?? [])];
  if (!tabs.length || tabs.some(tab => !panel.querySelector(`.npcp-pane[data-pane="${CSS.escape(tab.dataset.tab ?? '')}"]`))) {
    throw new Error('原版分类与设置内容不完整；请检查上游兼容性');
  }
  nav.setAttribute('role', 'tablist'); nav.setAttribute('aria-label', '众生侧写设置分类');
  const apiNote = document.createElement('div'); apiNote.className='npcp-host-managed-note npcp-host-api-note'; apiNote.textContent='此处保留原版端点配置，实际生成仍走梨园独立 npcParallel 模型岗位；端点测试和模型列表请求不在此执行。原设置不会覆盖梨园的模型渠道。'; panel.querySelector('.npcp-pane[data-pane="api"]')?.prepend(apiNote);
  const syncTabs = () => {
    for (const tab of tabs) {
      const id = tab.dataset.tab, pane = panel.querySelector(`.npcp-pane[data-pane="${CSS.escape(id)}"]`);
      const active = tab.classList.contains('active');
      tab.id ||= `npcp-host-tab-${id}`; pane.id ||= `npcp-host-pane-${id}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', pane.id);
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', tab.id);
    }
  };
  document.body.dataset.settingsReady = 'true';
  syncTabs();
  const observer = new MutationObserver(syncTabs);
  observer.observe(nav, {subtree:true, attributes:true, attributeFilter:['class']});
  nav.addEventListener('keydown', event => {
    const tab = event.target.closest?.('.npcp-tab'); if (!tab) return;
    let target = tab;
    const index = tabs.indexOf(tab);
    if (['ArrowDown', 'ArrowRight'].includes(event.key)) target = tabs[(index + 1) % tabs.length];
    else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) target = tabs[(index + tabs.length - 1) % tabs.length];
    else if (event.key === 'Home') target = tabs[0];
    else if (event.key === 'End') target = tabs.at(-1);
    else if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); target.focus(); target.click(); // Only the original handler changes the pane/settings.
  });
  const enhanced = new WeakSet();
  const enhanceControls = () => {
    for (const icon of panel.querySelectorAll('i.fa-solid,i.fa-regular')) if(icon.getAttribute('aria-hidden')!=='true')icon.setAttribute('aria-hidden','true');
    for (const control of panel.querySelectorAll('.menu_button,.npcp-icon-btn,.npcp-wi-picker-head')) {
      if (control.tagName === 'BUTTON' || enhanced.has(control)) continue;
      enhanced.add(control); control.setAttribute('role', 'button'); control.tabIndex = 0;
      if (!control.getAttribute('aria-label') && control.title) control.setAttribute('aria-label', control.title);
      control.addEventListener('keydown', event => {
        if (event.target !== control || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault(); control.click();
      });
    }
  };
  enhanceControls();
  const controlObserver = new MutationObserver(enhanceControls);
  controlObserver.observe(panel,{childList:true,subtree:true});
  // Floating-window positioning controls are not settings. The enclosing manager owns return/close.
  const dragHandle = document.getElementById('npcp_drag_handle');
  const stopDrag = event => { if (!event.target.closest('select,input,button,label')) event.stopPropagation(); };
  dragHandle?.addEventListener('mousedown', stopDrag, true);
  dragHandle?.addEventListener('touchstart', stopDrag, {capture:true,passive:true});
}
