/** Host adaptation only. Native helper implementations/bundles are never replaced. */
export function installFrontendApi(host, environment = globalThis) {
 if (host.frontendApiInstalled) return;
 host.frontendApiInstalled = true;
 const params = new URLSearchParams(environment.location.search);
 const pending = new Map();
 let closed = false;
 const binding = () => {
  const context = host.context, entryId = params.get('entryId');
  if (closed || params.get('view') !== 'render' || environment.parent === environment || !context || !entryId ||
      !context.visibleEntryIds?.includes(entryId) || !context.chat?.some(row => row.__liyuanEntryId === entryId) ||
      params.get('scopeKey') && params.get('scopeKey') !== context.scopeKey) {
   throw new Error('此脚本不是当前来源绑定的原前端，不能提交输入');
  }
  return {entryId, entryScope: context.scopeKey, sourceEntryId: context.sourceEntryId};
 };
 const receive = event => {
  if (event.source !== environment.parent || event.origin !== environment.location.origin || event.data?.type !== 'liyuan-tavern-command-result') return;
  const data = event.data, request = pending.get(data.requestId);
  if (!request || data.entryId !== request.binding.entryId || data.entryScope !== request.binding.entryScope || data.sourceEntryId !== request.binding.sourceEntryId) return;
  pending.delete(data.requestId); environment.clearTimeout(request.timer);
  try {
   const current = binding();
   if (host.context !== request.context || current.entryId !== request.binding.entryId || current.entryScope !== request.binding.entryScope || current.sourceEntryId !== request.binding.sourceEntryId) throw new Error('前端来源已变化，旧命令结果未采用');
   if (!data.ok) throw new Error(typeof data.error === 'string' ? data.error : '输入未被接收');
   request.resolve({pipe: typeof data.pipe === 'string' ? data.pipe : '', isAborted: false, isError: false});
  } catch (error) { request.reject(error); }
 };
 environment.addEventListener('message', receive);
 environment.addEventListener('pagehide', () => {
  closed = true; environment.removeEventListener('message', receive);
  for (const request of pending.values()) { environment.clearTimeout(request.timer); request.reject(new Error('原前端已关闭，未自动重试命令')); }
  pending.clear();
 }, {once: true});
 const requestCommand = raw => {
  const bound = binding();
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 256000 || pending.size >= 32) return Promise.reject(new Error('前端命令无效或等待中的请求过多'));
  const requestId = environment.crypto.randomUUID(), context = host.context;
  return new Promise((resolve, reject) => {
   const timer = environment.setTimeout(() => { pending.delete(requestId); reject(new Error('输入提交回执超时，请先核对聊天记录，不会自动重试')); }, 15000);
   pending.set(requestId, {resolve, reject, timer, binding: bound, context});
   try { environment.parent.postMessage({type: 'liyuan-tavern-command', requestId, command: raw, ...bound}, environment.location.origin); }
   catch (error) { pending.delete(requestId); environment.clearTimeout(timer); reject(error); }
  });
 };
 const originalContext = host.getContext;
 host.getContext = function(...args) {
  const result = originalContext.apply(this, args);
  // Do not shadow the bound headers with an unscoped Content-Type-only shim.
  if (this.modules['/script.js']?.getRequestHeaders) result.getRequestHeaders = this.modules['/script.js'].getRequestHeaders;
  return result;
 };
 const originalModules = host.installModules;
 host.installModules = function(...args) {
  const result = originalModules.apply(this, args);
  const card = this.characters?.[0];
  if (card?.data && card.data.alternate_greetings === undefined) card.data.alternate_greetings = [];
  const script = this.modules['/script.js'], personas = this.modules['/scripts/personas.js'];
  const power = this.modules['/scripts/power-user.js']?.power_user;
  if (power && personas && script) {
   const avatar = personas.user_avatar || script.user_avatar;
   const fail = () => { throw new Error('当前身份为梨园只读投影，请使用梨园身份设置；未修改生产身份'); };
   const tables = {
    personas: Object.freeze({[avatar]: this.context.userName ?? script.name1 ?? ''}),
    persona_descriptions: Object.freeze({[avatar]: Object.freeze({description: this.context.userPersona ?? '', connections: Object.freeze([])})}),
    default_persona: null,
   };
   for (const [key, value] of Object.entries(tables)) Object.defineProperty(power, key, {configurable: true, enumerable: true, get: () => value, set: fail});
  }
  const extensions = this.modules['/scripts/extensions.js'];
  if (extensions?.extensionTypes) {
   for (const [id, slug] of [['helper', 'JS-Slash-Runner'], ['template', 'ST-Prompt-Template']]) {
    if (this.context.plugins?.some(plugin => plugin.id === id && typeof plugin.version === 'string' && plugin.version)) extensions.extensionTypes['third-party/' + slug] = 'local';
   }
  }
  const openai = this.modules['/scripts/openai.js'];
  if (openai) openai.sendOpenAIRequest = async (_type, messages, signal) => {
   signal?.throwIfAborted();
   const bound = this.context, settings = openai.oai_settings ?? {};
   const data = {messages, stream: false,
    ...(settings.openai_max_tokens !== undefined ? {max_tokens: settings.openai_max_tokens} : {}),
    ...(settings.temp_openai !== undefined ? {temperature: settings.temp_openai} : {}),
   };
   // This is the native request hook, not an additional author/prompt injection point.
   if (script.eventSource) await script.eventSource.emit(script.event_types.CHAT_COMPLETION_SETTINGS_READY, data);
   signal?.throwIfAborted();
   if (this.context !== bound) throw new Error('脚本生成来源已变化，未发起请求');
   if (['tools', 'tool_choice', 'json_schema', 'response_format'].some(key => data[key] !== undefined)) throw new Error('受管脚本通道尚不支持独立工具或结构化输出；未丢弃参数，也未调用模型');
   const supported = new Set(['messages', 'stream', 'max_tokens', 'temperature', 'include_reasoning']);
   for (const key of Object.keys(data)) if (!supported.has(key)) throw new Error('受管脚本通道尚不支持参数 ' + key + '；未丢弃参数，也未调用模型');
   const payload = {messages: data.messages.map(message => {
    if (typeof message.content === 'string') return {role: message.role, content: message.content};
    if (!Array.isArray(message.content) || message.content.some(part => part.type !== 'text' || typeof part.text !== 'string')) throw new Error('受管脚本通道尚不支持此多模态消息；未丢弃输入');
    return {role: message.role, content: message.content.map(part => part.text).join('')};
   }), stream: data.stream, ...(data.max_tokens !== undefined ? {max_tokens: data.max_tokens} : {}), ...(data.temperature !== undefined ? {temperature: data.temperature} : {})};
   return this.request('/generate', payload, bound, signal);
  };
  const presetManager = this.modules['/scripts/preset-manager.js']?.getPresetManager();
  if (presetManager?.savePreset) {
   const savePreset = presetManager.savePreset;
   presetManager.savePreset = async (name, preset, ...options) => {
    const current = this.presets[0];
    if (!current || name != null && name !== current.name || !preset || typeof preset !== 'object' ||
        Object.entries(preset).some(([key, value]) => key !== 'extensions' && JSON.stringify(value) !== JSON.stringify(current[key]))) {
     throw new Error('此原预设接口仅保存插件扩展，不能改写或切换生产预设；未报告保存成功');
    }
    return savePreset.call(presetManager, name, preset, ...options);
   };
  }
  const slash = this.modules['/scripts/slash-commands.js'], execute = slash.executeSlashCommandsWithOptions;
  slash.executeSlashCommandsWithOptions = (raw, ...options) => /^\s*\/(?:send|setinput|trigger)(?:\s|$)/i.test(String(raw)) ? requestCommand(raw) : execute(raw, ...options);
  this.modules['/scripts/macros.js'].getLastMessageId = ({filter} = {}) => {
   if (filter !== undefined && typeof filter !== 'function') throw new Error('消息过滤器必须是函数');
   for (let index = this.chat.length - 1; index >= 0; index--) if (!filter || filter(this.chat[index], index)) return index;
   return null;
  };
  return result;
 };
 const send = environment.document?.querySelector?.('#send_but');
 send?.addEventListener('click', async () => {
  if (send.disabled) return;
  send.disabled = true;
  try {
   const value = environment.document.querySelector('#send_textarea')?.value ?? '';
   await requestCommand(value ? '/send ' + value + '|/trigger' : '/trigger');
  } catch (error) {
   const message = String(error?.message ?? error);
   host.errors.push(message);
   environment.toastr?.error(message, '输入未提交');
   environment.dispatchEvent(new environment.CustomEvent('liyuan-plugin-error', {detail: String(error?.message ?? error)}));
  } finally { send.disabled = false; }
 });
}

/** Native helper's top-window ST selectors must resolve to this host's own bounded chat DOM. */
export function installFrontendDomContext(host, environment = globalThis) {
 if (host.frontendDomInstalled || typeof environment.$ !== 'function' || !environment.parent?.document || environment.parent.document === environment.document) return;
 host.frontendDomInstalled = true;
 const native = environment.$, appDocument = environment.parent.document;
 const adapted = new Proxy(native, {apply(target, receiver, args) {
  const [selector, context] = args;
  if (context === appDocument && typeof selector === 'string' && /^#chat(?:[\s>\[]|$)/.test(selector.trim())) args[1] = environment.document;
  return Reflect.apply(target, receiver, args);
 }});
 environment.$ = adapted;
 if (environment.jQuery === native) environment.jQuery = adapted;
}
