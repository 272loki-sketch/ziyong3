import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { FishTtsHttp } from '../../server/fish-tts-http.ts';
const root = resolve(new URL('../..', import.meta.url).pathname);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 120; n++) { if (fn()) return; await delay(20); } assert.fail('synthetic state did not settle'); }
function silence() {
 const length = 8000, bytes = Buffer.alloc(44 + length * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8,4); bytes.write('WAVEfmt ',8); bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22); bytes.writeUInt32LE(8000,24); bytes.writeUInt32LE(16000,28); bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34); bytes.write('data',36); bytes.writeUInt32LE(length*2,40); return bytes;
}
test('Fish TTS: real host + plugin center, ID/aliases/save, multivoice preview/cache/stop, stale drafts, desktop/mobile', { timeout: 90_000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-fish-browser-')); let server, browser, calls = 0, source = 'story-a', pending = false, aborted = false, sent;
 const errors = [], external = [];let connectionChecks=0;
 const host = new FishTtsHttp(cwd, { binding: () => ({ sessionId: 'synthetic-session', card: 'synthetic-card', sourceEntryId: source, visibleEntryIds: ['story-a', source] }) }, { env: {}, fetch: async (url, init) => {
  if(url==='https://api.fish.audio/model?page_size=1'){connectionChecks++;assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.headers,undefined);return Response.json({models:[]});}
  calls++; sent = JSON.parse(init.body); assert.equal(url, 'https://api.fish.audio/v1/tts');
  if(pending) await new Promise((resolve,reject)=>{const stop=()=>{aborted=true;reject(init.signal.reason)};if(init.signal.aborted)stop();else init.signal.addEventListener('abort',stop,{once:true});});
  return new Response(silence(), { headers: { 'content-type': 'audio/mpeg' } });
 }});
 t.signal.addEventListener('abort',()=>{host.close();server?.closeAllConnections();void browser?.close()},{once:true});
 try {
  const sourceCode = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{TavernPluginsManager}from'./src/components/TavernPluginsManager.tsx';import{FishTtsMessage}from'./src/components/FishTtsPlayer.tsx';import{PanelRefreshContext}from'./src/components/kit.tsx';function App(){const[open,setOpen]=useState(false),[tick,setTick]=useState(0);window.__advanceContext=()=>setTick(t=>t+1);return <PanelRefreshContext.Provider value={tick}><button className="tavern-plugin-entry" onClick={()=>setOpen(true)}>插件中心</button><main style={{maxWidth:780,margin:'auto',padding:12}}><p id="story">合成正文不应被配音改动。</p><FishTtsMessage text={'<thinking>角色甲：不应送入语音。</thinking>\\n堀北：“你迟到了。”\\n绫小路：“抱歉。”'} entryId="story-a" entryScope=${JSON.stringify(host.status().binding.scopeKey)}/></main>{open&&<TavernPluginsManager onClose={()=>setOpen(false)} toast={()=>{}} contextTick={tick}/>}</PanelRefreshContext.Provider>}createRoot(document.getElementById('root')).render(<App/>);`;
  const result = await build({ stdin: { contents: sourceCode, resolveDir: join(root,'web'), loader:'tsx' },bundle:true,format:'esm',jsx:'automatic',write:false,loader:{'.css':'empty'},logLevel:'silent' });
  const css = (await Promise.all(['web/src/app.css','web/src/components/TavernPluginsPanel.css','web/src/components/FishTtsPanel.css'].map(path=>readFile(join(root,path),'utf8')))).join('\n');
  server=createServer(async(req,res)=>{
   if(await host.handle(req,res))return;
   if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(result.outputFiles[0].text);return;}
   if(req.url==='/fixture.css'){res.writeHead(200,{'content-type':'text/css'});res.end(css);return;}
   if(req.url==='/tavern-plugin-sw.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end("self.addEventListener('install',()=>self.skipWaiting());");return;}
   if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');return;}
   res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1365,height:960}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
  const openManager=async()=>{await page.getByRole('button',{name:'插件中心',exact:true}).click();await page.getByRole('button',{name:'管理Fish Audio 角色配音',exact:true}).click();await page.getByLabel('Fish API Key',{exact:true}).waitFor();};
  await openManager();const panel=page.getByRole('region',{name:'Fish Audio 角色配音设置'});assert.equal(calls,0);
  await panel.getByRole('button',{name:'检查 Fish 连接（免费，不合成）',exact:true}).click();await panel.getByRole('status').filter({hasText:'Fish 官方接口已连通'}).waitFor();assert.equal(connectionChecks,1);assert.equal(calls,0);assert.equal(host.status().config.enabled,false);
  await panel.getByLabel('Fish 网络线路',{exact:true}).selectOption('compatible');
  await panel.getByLabel('启用 Fish Audio 角色配音',{exact:true}).check();await panel.getByLabel('Fish API Key',{exact:true}).fill('synthetic-key');
  const add=panel.getByRole('button',{name:'通过 ID 添加角色音色',exact:true});
  await add.click();await panel.getByLabel('角色名',{exact:true}).nth(0).fill('堀北铃音');await panel.getByLabel('角色别名',{exact:true}).nth(0).fill('堀北，铃音');await panel.getByLabel('Fish 音色 ID',{exact:true}).nth(0).fill('https://fish.audio/m/'+'1'.repeat(32));
  await add.click();await panel.getByLabel('角色名',{exact:true}).nth(1).fill('绫小路清隆');await panel.getByLabel('角色别名',{exact:true}).nth(1).fill('绫小路');await panel.getByLabel('Fish 音色 ID',{exact:true}).nth(1).fill('2'.repeat(32));
  await panel.getByRole('button',{name:'保存配音设置',exact:true}).click();await panel.getByText('音色与配音设置已保存。未发起语音合成。',{exact:true}).waitFor();assert.equal(await panel.getByLabel('Fish API Key',{exact:true}).inputValue(),'');assert.equal(calls,0);
  assert.deepEqual(host.status().config.voices[0].aliases,['堀北','铃音']);assert.equal(host.status().config.voices[0].referenceId,'1'.repeat(32));
  await panel.getByLabel('角色别名',{exact:true}).nth(1).fill('铃音');await panel.getByRole('button',{name:'保存配音设置',exact:true}).click();await panel.getByRole('alert').filter({hasText:'重复'}).waitFor();assert.equal(host.status().config.voices[1].aliases[0],'绫小路');
  await panel.getByLabel('角色别名',{exact:true}).nth(1).fill('绫小路');await panel.getByRole('button',{name:'保存配音设置',exact:true}).click();await panel.getByText('音色与配音设置已保存。未发起语音合成。',{exact:true}).waitFor();
  await panel.getByLabel('角色名',{exact:true}).nth(0).fill('未保存的合成编辑');page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:/^全部插件/}).click();assert.equal(await panel.getByLabel('角色名',{exact:true}).nth(0).inputValue(),'未保存的合成编辑');
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:/^全部插件/}).click();await page.getByRole('button',{name:'管理Fish Audio 角色配音',exact:true}).click();await panel.getByLabel('角色名',{exact:true}).nth(0).waitFor();assert.equal(await panel.getByLabel('角色名',{exact:true}).nth(0).inputValue(),'堀北铃音');
  await panel.getByLabel('角色别名',{exact:true}).nth(0).fill('堀北，铃音，新别名');source='story-b';await page.evaluate(()=>window.__advanceContext());await panel.getByRole('alert').filter({hasText:'未保存的编辑仍保留'}).waitFor();assert.equal(await panel.getByRole('button',{name:'保存配音设置',exact:true}).isDisabled(),true);assert.match(await panel.getByLabel('角色别名',{exact:true}).nth(0).inputValue(),/新别名/);
  page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'刷新设置',exact:true}).click();await until(()=>host.status().binding.sourceEntryId==='story-b');await panel.getByLabel('角色名',{exact:true}).nth(0).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('.tavern-app-manager').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);assert.equal(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);assert.equal(await page.locator('body').evaluate(node=>node.scrollWidth<=innerWidth+1),true);
  await panel.getByRole('button',{name:'试听此音色',exact:true}).first().click();await panel.locator('.fish-tts-segments li').waitFor();assert.equal(await panel.locator('.fish-tts-segments li strong').textContent(),'堀北铃音');assert.equal(calls,0);
  await page.getByRole('button',{name:'关闭酒馆插件管理',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'});
  await page.getByRole('button',{name:'角色配音',exact:true}).click();const player=page.getByRole('region',{name:'角色配音预览与播放'});await player.locator('.fish-tts-segments li').nth(1).waitFor();assert.match(await player.locator('.fish-tts-segments').textContent(),/堀北铃音/);assert.doesNotMatch(await player.locator('.fish-tts-segments').textContent(),/不应送入语音/);assert.equal(calls,0);
  await player.getByRole('button',{name:'生成并播放',exact:true}).click();await player.locator('audio').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('.fish-tts-player audio')?.readyState>=1);assert.equal(await player.locator('audio').evaluate(node=>node.error),null);assert.equal(calls,1);assert.deepEqual(sent.reference_id,['1'.repeat(32),'2'.repeat(32)]);assert.equal(sent.text,'<|speaker:0|>你迟到了。<|speaker:1|>抱歉。');
  await player.getByRole('button',{name:'生成并播放',exact:true}).click();await until(()=>!host.status().busy);await page.waitForTimeout(100);assert.equal(calls,1);assert.equal(await page.locator('#story').textContent(),'合成正文不应被配音改动。');
  await player.getByLabel('本次配音选段',{exact:true}).fill('堀北：新的合成对白。');await player.getByRole('button',{name:'识别预览（不调用 Fish）',exact:true}).click();await player.locator('.fish-tts-segments li').waitFor();pending=true;
  await player.getByRole('button',{name:'生成并播放',exact:true}).click();await until(()=>calls===2);await player.getByRole('button',{name:'停止',exact:true}).click();await until(()=>aborted&&!host.status().busy);assert.equal(calls,2);
  await page.evaluate(()=>window.dispatchEvent(new Event('liyuan:workspace-changed')));await player.getByRole('alert').filter({hasText:'旧配音已停止'}).waitFor();assert.equal(await player.locator('audio').evaluate(node=>node.paused),true);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 } finally {host.close();await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await rm(cwd,{recursive:true,force:true});}
});
