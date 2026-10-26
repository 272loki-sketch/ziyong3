// Presentation/event compatibility only. Native Vue handlers and plugin settings stay authoritative.
import { applyLocale } from './i18n.js';

export function installSettingsUI({ view, plugin, focus }) {
 const roots = ['extensions_settings', 'extensions_settings2'].map(id => document.getElementById(id)).filter(Boolean);
 const initialized = new WeakSet(); let sequence = 0;
 const themeRoot = (() => { try { return parent.document.documentElement; } catch { return document.documentElement; } })();
 const syncTheme = () => {
  let theme = themeRoot.dataset.theme;
  if (!theme) { try { theme = localStorage.getItem('liyuan.theme'); } catch {} }
  const value = theme === 'dark' || theme === 'eye-care' ? theme : 'light';
  if (document.documentElement.dataset.theme !== value) document.documentElement.dataset.theme = value;
 };
 syncTheme();
 const themeObserver = new MutationObserver(syncTheme);
 themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });
 window.addEventListener('storage', syncTheme);
 const interactive = 'input, select, textarea, button, a, [contenteditable="true"]';
 const toggleDrawer = (header, target) => {
  if (target instanceof Element && target.closest(interactive)) return;
  const drawer = header.closest('.inline-drawer');
  const content = drawer?.querySelector(':scope > .inline-drawer-content');
  if (!content) return;
  const open = header.getAttribute('aria-expanded') !== 'true';
  header.setAttribute('aria-expanded', String(open));
  const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
  icon?.classList.toggle('down', !open); icon?.classList.toggle('up', open);
  icon?.classList.toggle('fa-circle-chevron-down', !open); icon?.classList.toggle('fa-circle-chevron-up', open);
  // Original extensions listen for this exact native host event.
  window.$?.(drawer).trigger('inline-drawer-toggle');
  content.style.display = open ? 'block' : 'none';
 };
 const enhance = root => {
  applyLocale(root);
  // Identify the original Vue MVU drawer by its own UI structure, never a translated title.
  for (const section of root.querySelectorAll('.mvu-section')) {
   const drawer=section.closest('.inline-drawer');
   if(drawer&&!drawer.classList.contains('liyuan-mvu-settings'))drawer.classList.add('liyuan-mvu-settings');
   if(focus==='mvu'&&drawer){let mount=drawer;while(mount.parentElement&&mount.parentElement!==root)mount=mount.parentElement;if(!mount.classList.contains('liyuan-mvu-mount'))mount.classList.add('liyuan-mvu-mount');}
  }
  for (const drawer of root.querySelectorAll('.inline-drawer')) {
   const header = drawer.querySelector(':scope > .inline-drawer-toggle');
   const content = drawer.querySelector(':scope > .inline-drawer-content');
   if (!header || !content || initialized.has(header)) continue;
   initialized.add(header);
   const open = view === 'manager';
   if (!content.id) content.id = `liyuan-plugin-drawer-${++sequence}`;
   header.setAttribute('role', 'button'); header.tabIndex = 0;
   header.setAttribute('aria-controls', content.id); header.setAttribute('aria-expanded', String(open));
   content.style.display = open ? 'block' : 'none';
   const icon = header.querySelector('.inline-drawer-icon');
   icon?.classList.toggle('down', !open); icon?.classList.toggle('up', open);
   icon?.classList.toggle('fa-circle-chevron-down', !open); icon?.classList.toggle('fa-circle-chevron-up', open);
   header.addEventListener('click', event => toggleDrawer(header, event.target));
   header.addEventListener('keydown', event => {
    if (event.target !== header || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); toggleDrawer(header, header);
   });
  }
  // Native fieldset groups have labels but no Tavern/Vue fold handler. Supply one
  // in the manager only, without wrapping/cloning their inputs or altering settings.
  if (view === 'manager') for (const section of root.querySelectorAll('#tavern_helper fieldset.TH-fieldset:not(.TH-collapsible)')) {
   const legend = section.querySelector(':scope > legend');
   const parts = [...section.children].filter(child => child.tagName !== 'LEGEND');
   if (!legend || !parts.length) continue;
   if (!initialized.has(legend)) {
    initialized.add(legend); legend.classList.add('liyuan-helper-section-toggle');
    legend.setAttribute('role', 'button'); legend.tabIndex = 0;
    for (const part of parts) if (!part.id) part.id = `liyuan-helper-section-${++sequence}`;
    legend.setAttribute('aria-controls', parts.map(part => part.id).join(' '));
    const toggle = () => { section.classList.toggle('liyuan-section-collapsed'); legend.setAttribute('aria-expanded', String(!section.classList.contains('liyuan-section-collapsed'))); };
    legend.addEventListener('click', event => { if (!(event.target instanceof Element) || !event.target.closest(interactive)) toggle(); });
    legend.addEventListener('keydown', event => { if (event.target === legend && ['Enter', ' '].includes(event.key)) { event.preventDefault(); toggle(); } });
   }
   legend.setAttribute('aria-expanded', String(!section.classList.contains('liyuan-section-collapsed')));
  }
  // Vue owns its inner collapsibles. Add keyboard/ARIA without adding a second click toggle.
  for (const fold of root.querySelectorAll('#tavern_helper .TH-collapsible')) {
   const header = fold.querySelector(':scope > div:not(.TH-collapsible--content)');
   const content = fold.querySelector(':scope > .TH-collapsible--content');
   if (!header || !content) continue;
   if (!initialized.has(header)) {
    initialized.add(header); header.classList.add('liyuan-helper-fold-toggle');
    if (!content.id) content.id = `liyuan-helper-fold-${++sequence}`;
    header.setAttribute('role', 'button'); header.tabIndex = 0; header.setAttribute('aria-controls', content.id);
    header.addEventListener('keydown', event => { if (event.target === header && ['Enter', ' '].includes(event.key)) { event.preventDefault(); header.click(); } });
   }
   header.setAttribute('aria-expanded', String(fold.classList.contains('expanded')));
  }
  const navbar = root.querySelector('#tavern_helper > .inline-drawer > .inline-drawer-content > div > div:nth-child(2)');
  if (navbar) {
   if (!navbar.classList.contains('liyuan-helper-tabs')) navbar.classList.add('liyuan-helper-tabs'); navbar.setAttribute('role', 'tablist'); navbar.setAttribute('aria-label', '酒馆助手设置分类');
   for (const tab of navbar.children) {
    if (!initialized.has(tab)) {
     initialized.add(tab); tab.setAttribute('role', 'tab'); tab.tabIndex = 0;
     tab.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); tab.click(); }
      else if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
       event.preventDefault(); const tabs = [...navbar.children]; const index = tabs.indexOf(tab);
       const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
       next.focus(); next.click();
      }
     });
    }
    tab.setAttribute('aria-selected', String([...tab.classList].some(name => name.startsWith('bg-'))));
   }
  }
  const reset = root.querySelector('#pt_reset');
  if (reset) {
   reset.setAttribute('role', 'button'); reset.setAttribute('aria-label', '重置提示词模板设置'); reset.setAttribute('title', '重置提示词模板设置'); reset.tabIndex = 0;
   if (!initialized.has(reset)) {
    initialized.add(reset);
    reset.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); reset.click(); } });
   }
  }
  const sections = ['生成处理', '消息渲染', '进阶选项', '性能与缓存'];
  root.querySelectorAll('#prompt_template_settings > .inline-drawer > .inline-drawer-content > hr').forEach((hr, index) => { hr.dataset.section = sections[index] ?? '更多选项'; });
  if (view === 'manager' && plugin) {
   const other = root.querySelector(plugin === 'helper' ? '#prompt_template_settings' : '#tavern_helper');
   if (other) other.hidden = true;
  }
 };
 for (const root of roots) enhance(root);
 // Limit translation to extension UI, never the chat DOM or authored template contents.
 const observer = new MutationObserver(mutations => {
  for (const root of roots) if (mutations.some(mutation => root.contains(mutation.target))) enhance(root);
 });
 for (const root of roots) observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-i18n'] });
 window.addEventListener('pagehide', () => { observer.disconnect(); themeObserver.disconnect(); window.removeEventListener('storage', syncTheme); }, { once: true });
 return { refresh: () => roots.forEach(enhance), mvuReady: () => !!document.querySelector('#extensions_settings2 .liyuan-mvu-settings .mvu-section') };
}

/** Manager-only dependency routing. No runtime/story hooks or upstream assets are changed. */
export async function ensureManagerWorker(serviceWorker, origin, { timeoutMs = 5000 } = {}) {
 if (!serviceWorker) return false;
 const workerURL = new URL('/tavern-plugin-sw.js', origin).href;
 const controlled = () => serviceWorker.controller?.scriptURL === workerURL;
 if (controlled()) return true;
 let timer, check;
 const cleanups = [];
 const ready = new Promise(resolve => {
  let finished = false;
  const finish = value => {
   if (finished) return;
   finished = true;
   clearTimeout(timer);
   for (const cleanup of cleanups) cleanup();
   resolve(value);
  };
  check = () => { if (controlled()) finish(true); };
  serviceWorker.addEventListener('controllerchange', check);
  cleanups.push(() => serviceWorker.removeEventListener('controllerchange', check));
  timer = setTimeout(() => finish(false), timeoutMs);
  // Listen before register: a fast activation must not be lost between awaits.
  Promise.resolve().then(() => serviceWorker.register(workerURL, { scope: '/tavern-plugin-host.html', updateViaCache: 'none' })).then(check, () => finish(false));
  check();
 });
 return ready;
}
