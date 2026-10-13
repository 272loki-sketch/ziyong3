const host = () => {
  const value = window.LiyuanNpcParallelHost;
  if (!value) throw new Error('NPC Parallel 宿主尚未完成初始化');
  return value;
};

export const event_types = Object.freeze({
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_EDITED: 'MESSAGE_EDITED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  GENERATION_STARTED: 'GENERATION_STARTED',
  CHAT_CHANGED: 'CHAT_CHANGED',
});

const listeners = new Map();
export const eventSource = Object.freeze({
  on(type, listener) {
    if (typeof listener !== 'function') throw new TypeError('eventSource.on requires a function');
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
    return listener;
  },
  off(type, listener) { listeners.get(type)?.delete(listener); },
  emit(type, ...args) {
    if (!Object.values(event_types).includes(type)) throw new Error(`不支持的酒馆事件：${String(type)}`);
    if (host().mode === 'manager' && type === event_types.MESSAGE_RECEIVED) {
      throw new Error('管理页禁止触发NPC侧写生成');
    }
    const current = [...(listeners.get(type) ?? [])];
    for (const listener of current) listener(...args);
    return current.length;
  },
});

window.__npcParallelEventSource = eventSource;
window.__npcParallelEventTypes = event_types;

export async function generateQuietPrompt(options = {}) {
  const quietPrompt = options?.quietPrompt;
  const responseLength = Number(options?.responseLength);
  if (typeof quietPrompt !== 'string' || !quietPrompt.trim()) throw new Error('原版静默生成请求缺少 quietPrompt');
  if (!Number.isFinite(responseLength) || responseLength <= 0) throw new Error('原版静默生成请求的 responseLength 无效');
  return host().generateQuietPrompt({ quietPrompt, responseLength });
}

export function saveSettingsDebounced() {
  return host().saveSettingsDebounced();
}

export function substituteParams(value) {
  if (typeof value !== 'string') throw new TypeError('substituteParams 仅接受字符串');
  const context = host().getContext();
  const replacements = { user: context.name1 ?? '', char: context.name2 ?? '' };
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`梨园兼容宿主不支持酒馆宏 {{${key}}}`);
    return String(replacements[key]);
  });
}
