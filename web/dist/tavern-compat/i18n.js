// Host-side locale services. Upstream manifests/dictionaries remain byte-for-byte intact.
const messages = Object.create(null);
export function getCurrentLocale() {
 return globalThis.document?.documentElement?.lang || 'zh-CN';
}
export function t(strings, ...values) {
 if (typeof strings === 'string') return messages[strings] ?? strings;
 const key = strings.reduce((text, part, index) => text + part + (index < values.length ? `\${${index}}` : ''), '');
 return (messages[key] ?? key).replace(/\$\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}
export function applyLocale(root) {
 if (!root?.querySelectorAll) return root;
 const elements = [...(root.matches?.('[data-i18n]') ? [root] : []), ...root.querySelectorAll('[data-i18n]')];
 for (const element of elements) {
  for (const entry of element.getAttribute('data-i18n').split(';')) {
   const attribute = entry.match(/^\[([^\]]+)\](.+)$/);
   const value = messages[attribute ? attribute[2] : entry];
   if (typeof value !== 'string') continue;
   // Translate UI labels only: never change control values, scripts, or user-authored text.
   if (attribute) {
    if (['title', 'placeholder', 'aria-label', 'alt'].includes(attribute[1]) && element.getAttribute(attribute[1]) !== value) element.setAttribute(attribute[1], value);
   } else if (!element.matches('input, textarea, script, style')) {
    if (!element.children.length) { if (element.textContent !== value) element.textContent = value; }
    else { const text = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim()); if (text && text.textContent.trim() !== value) text.textContent = value; }
   }
  }
 }
 return root;
}
export function localizeTemplate(html) {
 const template = document.createElement('template'); template.innerHTML = html;
 applyLocale(template.content); return template.innerHTML;
}
export async function loadPluginLocales(plugins) {
 const locale = getCurrentLocale().toLowerCase();
 for (const plugin of plugins.filter(plugin => plugin.enabled)) {
  const slug = plugin.id === 'helper' ? 'JS-Slash-Runner' : plugin.id === 'template' ? 'ST-Prompt-Template' : null;
  if (!slug) continue;
  const base = `/tavern-compat/scripts/extensions/third-party/${slug}/`;
  const manifestResponse = await fetch(base + 'manifest.json');
  if (!manifestResponse.ok) throw new Error('无法读取原插件语言包清单');
  const manifest = await manifestResponse.json();
  const path = manifest.i18n?.[locale] ?? manifest.i18n?.[locale.split('-')[0]];
  if (!path) continue; // The helper's source labels are already Chinese.
  if (typeof path !== 'string' || /[\\?#]/.test(path) || path.split('/').some(part => !part || part.startsWith('.'))) throw new Error('原插件语言包路径无效');
  const response = await fetch(base + path);
  if (!response.ok) throw new Error('无法加载原插件中文语言包，请检查安装完整性');
  const data = await response.json();
  for (const [key, value] of Object.entries(data)) if (typeof value === 'string') messages[key] = value;
 }
}
