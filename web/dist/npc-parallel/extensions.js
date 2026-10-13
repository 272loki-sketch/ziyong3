const host = () => {
  const value = window.LiyuanNpcParallelHost;
  if (!value) throw new Error('NPC Parallel 宿主尚未完成初始化');
  return value;
};

export const extension_settings = window.__npcParallelExtensionSettings ?? Object.create(null);
export function getContext() { return host().getContext(); }

// host.js seeds this module-level object before the unchanged upstream module imports us.
window.__npcParallelExtensionSettings = extension_settings;
