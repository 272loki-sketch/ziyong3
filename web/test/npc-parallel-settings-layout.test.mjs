// Real upstream DOM inside the real app-level manager; all materials, settings and APIs are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
import {tavernVendorAsset} from '../../server/tavern-plugin-vendor.ts';

const root=resolve(new URL('../..',import.meta.url).pathname);
const fixture=process.env.NPC_PARALLEL_FIXTURE_ROOT&&resolve(process.env.NPC_PARALLEL_FIXTURE_ROOT);
const assetsRoot=process.env.NPC_PARALLEL_UI_ASSETS_ROOT?resolve(process.env.NPC_PARALLEL_UI_ASSETS_ROOT):root;
const originalFiles=['index.js','style.css','manifest.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('众生原设置整页：五分类/原控件/真实滚动/真实独立API说明/昼夜/1440·1024·390·320/返回/CAS/零模型', {timeout:120000}, async t=>{
 if(!fixture||!originalFiles.every(file=>existsSync(join(fixture,file)))){t.skip('必须显式提供原NPC资产fixture；未运行原版设置布局验收');return;}
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-npc-settings-layout-'));
 const originalHashes=Object.fromEntries(originalFiles.map(file=>[file,sha(readFileSync(join(fixture,file)))]));
 const manifest=JSON.parse(readFileSync(join(fixture,'manifest.json'),'utf8'));
 const commit=execFileSync('git',['-C',fixture,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 let settings={enabled:true,autoTrigger:true,theme:'day',template:'synthetic-preserved-template',futureUnknown:{keep:true},customApi:{enabled:false,endpoints:[]}};
 let metadata={npc_parallel:{npcs:[{name:'合成人物',notes:'仅用于隔离UI验收',always:false,weight:1}],ignoredNpcs:[]},futureMetadata:{keep:true}};
 let revision=0,browser,server,page,modelRequests=0,closed=0;
 const writes=[],pageErrors=[];
 const scopeKey='synthetic-ui-scope',sourceEntryId='synthetic-ui-author';
 const baseStatus={installed:true,enabled:true,autoUpdate:false,busy:false,ecologyEnabled:true,executionEnabled:true,model:{provider:'synthetic',id:'no-model-calls'},version:manifest.version,commit,upstreamCommit:commit,scopeKey,sourceEntryId};
 try{
  await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{TavernPluginsManager}from'./src/components/TavernPluginsManager.tsx';import './src/components/TavernPluginsPanel.css';createRoot(document.getElementById('root')).render(<TavernPluginsManager contextTick={0} toast={()=>{}} onClose={()=>window.__closed++}/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  await writeFile(join(cwd,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>*{box-sizing:border-box}:root{--bg:#f7f4f0;--surface:#fffcfa;--surface-dim:#f3efe9;--text:#3d3833;--text-strong:#1c1917;--text-soft:#6a635c;--hairline:#ebe6df;--hairline-strong:#d9d2c8;--accent:#b44b32;--accent-strong:#973b29;--accent-wash:#faeee7}body{margin:0;background:var(--bg);font-family:system-ui,sans-serif}.icon-btn{display:grid;place-items:center}</style></head><body><div id="root"></div><script>window.__closed=0</script><script type="module" src="/fixture.js"></script></body></html>`);
  const publicFiles={'/npc-parallel-host.html':'web/public/npc-parallel-host.html','/npc-parallel/host.js':'web/public/npc-parallel/host.js','/npc-parallel/host.css':'web/public/npc-parallel/host.css','/npc-parallel/script.js':'web/public/npc-parallel/script.js','/npc-parallel/scripts/extensions.js':'web/public/npc-parallel/extensions.js'};
  const vendorFiles={'/npc-parallel/vendor/jquery.js':'jquery.js','/npc-parallel/vendor/jquery-ui.js':'jquery-ui.js','/npc-parallel/vendor/jquery-touch-punch.js':'jquery-touch-punch.js','/npc-parallel/vendor/toastr.js':'toastr.js'};
  const pluginPrefix='/npc-parallel/scripts/extensions/third-party/npc-parallel/';
  server=createServer((req,res)=>{void(async()=>{
   const path=new URL(req.url,'http://localhost').pathname;
   const send=(code,bytes,type='application/json; charset=utf-8')=>{res.writeHead(code,{'content-type':type,'cache-control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(bytes):bytes);};
   const file=(p)=>send(200,readFileSync(p),p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
   if(req.method==='GET'){
    if(path==='/')return file(join(cwd,'index.html'));
    if(['/fixture.js','/fixture.css'].includes(path))return file(join(cwd,path.slice(1)));
    if(publicFiles[path])return file(join(assetsRoot,publicFiles[path]));
    if(vendorFiles[path])return file(tavernVendorAsset(root,vendorFiles[path]));
    if(path.startsWith(pluginPrefix)){const rel=decodeURIComponent(path.slice(pluginPrefix.length));if(!originalFiles.includes(rel))return send(404,{});return file(join(fixture,rel));}
    if(path==='/api/npc-parallel/status')return send(200,{...baseStatus,revision});
    if(path==='/api/npc-parallel/context')return send(200,{...baseStatus,revision,manifest,settings,metadata,npcs:metadata.npc_parallel.npcs,scope:{sessionId:'synthetic-ui-session',card:'synthetic-ui-card',sourceEntryId,visibleEntryIds:[sourceEntryId]},chat:[{entryId:sourceEntryId,is_user:false,mes:'仅合成管理页正文'}],worldbooks:{'合成世界书':{entries:[]}},userName:'合成用户',characterName:'合成主角'});
    if(path==='/api/veridis-rewrite/status')return send(200,{installed:false,enabled:false,autoUpdate:false,busy:false,settings:{}});
    if(path==='/api/tavern-plugins/status')return send(200,{plugins:[],checking:false});
    if(path==='/api/tavern-plugins/mvu/view')return send(200,{enabled:false,installed:false,dependencies:0,helper:{installed:false,enabled:false},binding:{scopeKey,sourceEntryId},streaming:false,pluginBusy:false,canRecover:false,variables:{rootCount:0,hasData:false}});
    return send(404,{});
   }
   if(req.method==='POST'&&path==='/api/npc-parallel/settings'){
    let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
    if(body.scopeKey!==scopeKey||body.sourceEntryId!==sourceEntryId||body.upstreamCommit!==commit||body.revision!==revision)return send(409,{error:'synthetic stale binding'});
    writes.push(body);settings=body.settings;metadata=body.metadata;revision++;
    return send(200,{scopeKey,sourceEntryId,revision});
   }
   modelRequests++;return send(403,{error:'synthetic fixture prohibits model/story writes'});
  })().catch(error=>{pageErrors.push(`fixture:${error.name}`);if(!res.headersSent)res.writeHead(500);res.end();});});
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE??join(root,'.liyuan-database-plugin/browser/headless_shell'),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??join(root,'.liyuan-database-plugin/browser-libs/lib64')},args:['--no-sandbox']});
  page=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(15000);
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'打开原版设置',exact:true}).click();
  const manager=page.getByRole('region',{name:'众生侧写原版设置'}),frame=page.frameLocator('iframe[title="众生侧写原版设置"]');
  await page.waitForFunction(()=>!document.querySelector('.npc-parallel-frame-wrap')?.classList.contains('is-not-ready'));
  await frame.getByRole('tab',{name:'通用',exact:true}).waitFor();
  assert.equal(await page.locator('.tavern-plugins-manager-content').count(),0,'设置必须离开多插件列表的嵌套滚动区');
  assert.equal(await page.locator('.npc-parallel-card').count(),0);
  for(const viewport of [{width:1440,height:1000},{width:1024,height:768},{width:390,height:844},{width:320,height:640}]){
   await page.setViewportSize(viewport);
   const box=await manager.boundingBox(),iframeBox=await manager.locator('iframe').boundingBox();
   const expectedWidth=Math.min(1120,viewport.width-(viewport.width<=600?14:40));
   assert.ok(box&&iframeBox&&iframeBox.width>=expectedWidth-5&&iframeBox.height>=300,`整页画布不能退回卡片：${JSON.stringify({viewport,box,iframeBox})}`);
   await page.waitForFunction(()=>{const f=document.querySelector('iframe');const r=f?.contentDocument?.getElementById('npcp_floating')?.getBoundingClientRect();return !!r&&r.y>=0&&r.bottom<=f.contentWindow.innerHeight+1;});
   await frame.locator('#npcp_floating').evaluate(panel=>{const r=panel.getBoundingClientRect();if(r.y<0||r.bottom>innerHeight+1)throw Error('embedded panel clipping');});
   for(const name of ['通用','API','NPC · 世界书','平行视角','日志']){await frame.getByRole('tab',{name,exact:true}).click();assert.equal(await frame.getByRole('tab',{name,exact:true}).getAttribute('aria-selected'),'true');}
   await frame.getByRole('tab',{name:'通用',exact:true}).click();
   await frame.locator('#npcp_template').scrollIntoViewIfNeeded();
   await frame.locator('#npcp_template').fill('synthetic-ui-edited-template');
   await frame.locator('#npcp_theme').selectOption(viewport.width>=1024?'day':'night');
   await frame.locator('html').evaluate((element,dark)=>{if(element.dataset.theme!==(dark?'dark':'light'))throw Error('theme mismatch');},viewport.width<1024);
   await frame.getByRole('tab',{name:'API',exact:true}).click();
   assert.equal(await frame.locator('#npcp_api_mode').isDisabled(),true,'API传输由独立受管岗位固定，不给人跟随正文的错觉');
   assert.match(await frame.locator('#npcp_api_mode').textContent(),/梨园独立受管 API.*synthetic.*no-model-calls/);
   assert.equal(await frame.locator('#npcp_api_cfg').isVisible(),false,'旧端点保留在配置里，不参与传输');
   await frame.getByRole('tab',{name:'通用',exact:true}).click();
   await frame.locator('#toast-container').evaluate(e=>{if(getComputedStyle(e).position!=='fixed')throw Error('toast must not shrink settings canvas');}).catch(error=>{if(!String(error.message).includes('Timeout'))throw error});
   await frame.locator('.npcp-tab-panes').evaluate(e=>e.scrollTo(0,0));
   if(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR,`app-manager-${viewport.width}.png`)});
  }
  await page.waitForTimeout(400);
  assert.equal(settings.template,'synthetic-ui-edited-template');
  assert.deepEqual(settings.futureUnknown,{keep:true});assert.deepEqual(metadata.futureMetadata,{keep:true});
  assert.equal(modelRequests,0,'原控件展开/保存不得旁路模型或故事写入');
  assert.ok(writes.length>0);assert.deepEqual(writes.map(b=>b.revision),writes.map((_,i)=>i));
  assert.ok(writes.every(b=>!Object.hasOwn(b,'chat')&&!Object.hasOwn(b,'extra')));
  await manager.getByRole('button',{name:'返回梨园管理'}).click();await page.locator('.npc-parallel-card').waitFor();
  await page.getByRole('button',{name:'打开原版设置',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.npc-parallel-frame-wrap')?.classList.contains('is-not-ready'));
  assert.equal(await frame.locator('#npcp_template').inputValue(),'synthetic-ui-edited-template');
  await frame.locator('body').press('Escape');await page.locator('.npc-parallel-card').waitFor();
  closed=await page.evaluate(()=>window.__closed);assert.equal(closed,0,'Escape从原设置回列表，不误关外层管理台');
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(Object.fromEntries(originalFiles.map(f=>[f,sha(readFileSync(join(fixture,f)))])),originalHashes,'原版文件字节保持不变');
 }catch(error){
  if(page&&!page.isClosed()){
   console.log('SYNTHETIC_LAYOUT_DIAGNOSTIC',JSON.stringify({pageErrors,frame:await page.locator('iframe').evaluateAll(nodes=>nodes.map(n=>({rect:n.getBoundingClientRect().toJSON(),url:n.getAttribute('src')}))),frames:await Promise.all(page.frames().map(async f=>({url:f.url(),layout:await f.evaluate(()=>({status:document.getElementById('npcp-host-message')?.textContent,root:document.getElementById('npcp_floating')?.getBoundingClientRect().toJSON(),tabs:[...document.querySelectorAll('.npcp-tab')].map(n=>({text:n.innerText,role:n.getAttribute('role'),rect:n.getBoundingClientRect().toJSON()}))})).catch(()=>null)})))}));
   await frame.locator('#toast-container').evaluate(e=>{if(getComputedStyle(e).position!=='fixed')throw Error('toast must not shrink settings canvas');}).catch(error=>{if(!String(error.message).includes('Timeout'))throw error});
   await frame.locator('.npcp-tab-panes').evaluate(e=>e.scrollTo(0,0));
   if(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.NPC_PARALLEL_UI_SCREENSHOT_DIR,'app-failure.png')}).catch(()=>{});
  }throw error;
 }finally{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(cwd,{recursive:true,force:true});}
});
