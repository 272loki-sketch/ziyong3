import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = resolve(new URL('../..', import.meta.url).pathname);
function between(source, start, end) {
 const from = source.indexOf(start);
 assert.ok(from >= 0, `missing source boundary: ${start}`);
 const to = source.indexOf(end, from + start.length);
 assert.ok(to > from, `missing source boundary: ${end}`);
 return source.slice(from, to);
}

// Source-extracted fixture, not full App integration: retain actual idle composer
// JSX, panel trigger, management JSX, input effect and send callback. Context,
// WS acceptance/ACK clearing and unrelated panels are synthetic. No production
// host, sessions, installed plugins, keys or model endpoints are used.
test('实际源码 compact composer：桌面/手机、菜单、88px、清空、模式与发送', { timeout: 60000 }, async () => {
 const app = await readFile(join(root, 'web/src/App.tsx'), 'utf8');
 const composer = between(app, '<div className="composer-shell composer-box">', '{/* 会话用量：输入框下方');
 const management = between(app, '<section className="turn-management"', '<PanelDock');
 const panelTrigger = between(app, '<button\n\t\t\t\t\t\ttype="button"\n\t\t\t\t\t\tclassName={`tb-btn ${centerMenu === "panels"', '<div\n\t\t\t\t\t\tclassName="build-version-status"');
 const inputEffect = between(app, 'useEffect(() => {\n\t\tconst field = inputRef.current;', '\n\n\tuseEffect');
 assert.match(inputEffect, /\}, \[input\]\);/);
 const send = between(app, 'const send = useCallback(() => {', '\n\n\t// 卡 HTML');
 const temp = await mkdtemp(join(tmpdir(), 'liyuan-composer-ui-'));
 let browser, server;
 const writes = [], errors = [], forbidden = [], results = [];
 try {
  const source = `import React,{useState,useRef,useEffect,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {GenerationModeControl} from './src/components/GenerationModeControl.tsx';
import {RealTestRecords} from './src/components/RealTestRecords.tsx';
import {buildStoryPromptFrame} from './src/generation-mode.ts';
import {apiPost} from './src/api.ts';
import {IconPlus,IconSessions,IconWorldline,IconRoster,IconAttach,IconStop,IconSend,IconSkills,IconAssistant,IconDock} from './src/components/icons.tsx';
function Harness(){
 const [input,setInput]=useState(''),inputRef=useRef(null),uploadInputRef=useRef(null);
 const [generationMode,onGenerationModeChange]=useState('director');
 const [centerMenu,setCenterMenu]=useState(null),[composerTools,setComposerTools]=useState(false);
 const [settlementRetrying,setSettlementRetrying]=useState(false);
 const busy=false,settling=false,activeAgentName=null,agentPanels=[],leftPanel=null,rightPanel=null;
 const restoredModeHint=null,restoredPromptModeRef=useRef(null),composerSubmissionsRef=useRef(new Map());
 const pending=[],suggestions=[],argHint=null,cmdIndex=0,uploading=false,conn='open',userName='合成用户';
 const planningOpen=false,asstUnread=false,coarse=matchMedia('(pointer: coarse)').matches;
 const atBottomRef=useRef(true);
 const noop=()=>{},setRestoredModeHint=noop,setCmdDismissed=noop,setCmdIndex=noop;
 const setWelcome=noop,setAtHome=noop,touchVisit=noop,setAsstUnread=noop,setAtBottom=noop;
 const openStoreModal=noop,openRight=noop,openLeft=noop,togglePanel=noop,setPlanningOpen=noop,doUpload=noop;
 const buildAttachmentLine=()=>'',looksBackstage=()=>false;
 const toggleCenter=id=>setCenterMenu(v=>v===id?null:id);
 const pushToast=(level,text)=>window.__toasts.push({level,text});
 const storyPromptForText=text=>buildStoryPromptFrame(text,generationMode);
 const ws={send:frame=>{window.__sent.push(frame);return {accepted:true,messageId:'synthetic-'+window.__sent.length,sessionId:'synthetic'};}};
 ${inputEffect}
 ${send}
 useEffect(()=>{window.__setInput=setInput;},[]);
 return <div className="app"><header className="topbar"><div className="tb-slot tb-slot-center">${panelTrigger}</div></header>
 {centerMenu==='panels'&&<div className="drop-panel">${management}</div>}
 <div className="body"><main className="main"><div className="messages"/><footer className="composer">${composer}</footer></main></div></div>;
}
window.__sent=[];window.__toasts=[];createRoot(document.getElementById('root')).render(<Harness/>);`;
  await build({ stdin: { contents: source, resolveDir: join(root, 'web'), loader: 'tsx' }, bundle: true, format: 'esm', jsx: 'automatic', outfile: join(temp, 'fixture.js'), loader: { '.css': 'empty' }, logLevel: 'silent' });
  await writeFile(join(temp, 'fixture.css'), await readFile(join(root, 'web/src/app.css'), 'utf8') + '\n' + await readFile(join(root, 'web/src/real-tests.css'), 'utf8'));
  await writeFile(join(temp, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  server = createServer(async (req, res) => {
   const path = new URL(req.url, 'http://localhost').pathname;
   if (req.method !== 'GET') writes.push(`${req.method} ${path}`);
   const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
   if (path === '/api/real-tests') return json({ records: [] });
   if (path === '/api/turn/retry-settlement' && req.method === 'POST') return json({ ok: true });
   const files = { '/': ['index.html', 'text/html'], '/fixture.js': ['fixture.js', 'text/javascript'], '/fixture.css': ['fixture.css', 'text/css'] };
   if (files[path]) { const [name, type] = files[path]; res.writeHead(200, { 'content-type': type }); return res.end(await readFile(join(temp, name))); }
   if (path !== '/favicon.ico') forbidden.push(`${req.method} ${path}`);
   res.writeHead(404); res.end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE || (existsSync(join(root, '.liyuan-database-plugin/browser/headless_shell')) ? join(root, '.liyuan-database-plugin/browser/headless_shell') : undefined);
  const libs = process.env.LIYUAN_DATABASE_BROWSER_LIBS || process.env.LD_LIBRARY_PATH || join(root, '.liyuan-database-plugin/browser-libs/lib64');
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), env: { ...process.env, LD_LIBRARY_PATH: libs }, args: ['--no-sandbox'] });
  for (const width of [1440, 390]) {
   const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 980 }, isMobile: width === 390, hasTouch: width === 390 });
   const page = await context.newPage(); page.setDefaultTimeout(8000);
   page.on('pageerror', error => errors.push(error.message));
   await page.route('**/*', route => { if (new URL(route.request().url()).origin !== base) { forbidden.push(route.request().url()); return route.abort(); } return route.continue(); });
   await page.goto(base);
   const field = page.locator('#send_textarea'), box = page.locator('.composer');
    await field.waitFor();
    assert.equal(await page.locator('.composer-mode-row').count(), 0);
    const positions = await page.evaluate(() => {
     const field = document.querySelector('#send_textarea').getBoundingClientRect();
     const modes = document.querySelector('.composer-mode-inline').getBoundingClientRect();
     return { field: field.toJSON(), modes: modes.toJSON() };
    });
    assert.ok(positions.modes.right <= positions.field.left && positions.modes.top < positions.field.bottom && positions.modes.bottom > positions.field.top, JSON.stringify(positions));
   assert.equal(await box.getByRole('button', { name: '实战记录', exact: true }).count(), 0);
   assert.equal(await box.getByRole('button', { name: '重试结算', exact: true }).count(), 0);
   const noOverflow = async () => {
    const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, composer: document.querySelector('.composer').scrollWidth, composerWidth: document.querySelector('.composer').clientWidth, box: document.querySelector('.composer-box').getBoundingClientRect().toJSON() }));
    assert.ok(metrics.document <= width && metrics.body <= width && metrics.composer <= metrics.composerWidth && metrics.box.x >= 0 && metrics.box.right <= width, JSON.stringify(metrics));
   };
   await noOverflow();
    const baseline = await field.evaluate(el => el.getBoundingClientRect().height);
    assert.ok(baseline <= 40, `empty input must remain a single line: ${baseline}px`);
   const long = ('合成多行长文 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n').repeat(60);
   await field.fill(long);
   await page.waitForFunction(() => document.querySelector('#send_textarea').getBoundingClientRect().height >= 87);
   const height = await field.evaluate(el => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
   assert.ok(height.height <= 88 && height.scroll > height.client); assert.equal(height.overflow, 'auto');
   await noOverflow();
   await field.fill('');
   await page.waitForFunction(h => document.querySelector('#send_textarea').getBoundingClientRect().height <= h + 1, baseline);
   // Programmatic state changes do not run textarea onChange: this isolates [input].
   await page.evaluate(text => window.__setInput(text), long);
   await page.waitForFunction(() => document.querySelector('#send_textarea').getBoundingClientRect().height >= 87);
   await page.evaluate(() => window.__setInput(''));
   await page.waitForFunction(h => document.querySelector('#send_textarea').getBoundingClientRect().height <= h + 1, baseline);
   assert.equal(await field.inputValue(), '');
   await page.getByRole('button', { name: '面板', exact: true }).click();
   const menu = page.locator('.turn-management'); await menu.waitFor();
   await menu.getByRole('button', { name: '实战记录', exact: true }).click();
   await page.getByRole('dialog', { name: '实战记录', exact: true }).waitFor();
   await page.getByText('暂无已发布实战记录。').waitFor();
   await page.getByRole('button', { name: '返回梨园' }).click();
   await menu.getByRole('button', { name: '重试结算', exact: true }).click();
   await page.waitForFunction(() => window.__toasts.some(t => t.text === '未完成结算已恢复，正文未重写'));
   await noOverflow();
   await page.getByRole('button', { name: '面板', exact: true }).click();
   for (const [mode, label] of [['direct', '直出'], ['director', '导演']]) {
    const radio = box.getByRole('radio', { name: label, exact: true }); await radio.click();
    assert.equal(await radio.getAttribute('aria-checked'), 'true');
    await field.fill(long);
    await page.locator('#send_but').click();
    const sent = await page.evaluate(() => window.__sent.at(-1));
    assert.equal(sent.type, 'prompt'); assert.equal(sent.generationMode, mode); assert.equal(sent.text, long.trim());
    // Synthetic accepted-input ACK, not a test of App's real WS ACK handler.
    await page.evaluate(() => window.__setInput(''));
    await page.waitForFunction(h => document.querySelector('#send_textarea').getBoundingClientRect().height <= h + 1, baseline);
    assert.equal(await page.locator('#send_but').isDisabled(), true);
   }
   assert.equal(await page.evaluate(() => window.__sent.length), 2);
   await noOverflow();
   results.push({ width, singleLineHeight: baseline, longTextHeight: height.height, modes: ['direct', 'director'], menuEntries: true, horizontalOverflow: false });
   await context.close();
  }
  assert.deepEqual(writes, ['POST /api/turn/retry-settlement', 'POST /api/turn/retry-settlement']);
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ scope: 'source-extracted idle composer; mocked REST/WS and ACK', results, writes, errors }));
 } finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await rm(temp, { recursive: true, force: true });
 }
});
