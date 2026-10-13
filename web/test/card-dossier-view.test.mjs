// First-floor comparison with synthetic saved MVU state. No production dialogue, mutation or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
import {stringify,parse} from 'yaml';

const root=resolve(new URL('../..',import.meta.url).pathname);
const firstState={主角状态:{修为:{当前境界:'合成境界',进度百分比:0},灵石钱包:{下品灵石:50}},世界系统:{当前时间:'合成初始日期',修仙秘闻:{合成条目:'保留未发生变化的条目。'},修仙八卦论坛:{合成公告:{标签:'普通',详情描述:Array(12).fill('用于比较首楼与后续楼层阅读样式的合成说明。').join('\n')}}},人际交往:{道友录:{合成人物:{好感:40,描述:'合成测试人物。'}}}};
const snapshot=structuredClone(firstState);snapshot.世界系统.当前时间='合成更新日期 子时';snapshot.人际交往.道友录.合成人物.好感=42;
snapshot.人际交往.道友录.合成人物.描述='<img src=x> 应当保持普通文字，不能创建图片。';
const source='<Analysis>合成推演分析，不应取代状态卷宗。</Analysis>\n<JSONPatch>[{"op":"delta","path":"/人际交往/道友录/合成人物/好感","value":2}]</JSONPatch>';
const synthetic='\n```html\n<!doctype html><html><head></head><body><div class="cxtd-box"><details><summary class="cxtd-head"><span class="cxtd-title">合成卷宗 · 推演完成</span><span class="cxtd-ava"></span></summary><div class="cxtd-body">$1</div></details></div><style>.cxtd-box{max-width:650px;margin:18px auto;border:1px solid #d6a95288;border-radius:12px;background:#0c101d;overflow:hidden}.cxtd-head{display:flex;gap:12px;padding:12px 20px;color:#f7d98a;cursor:pointer}.cxtd-title{font-size:14px;white-space:nowrap}.cxtd-body{padding:16px 20px;max-height:400px;overflow-y:auto;font-size:12px;line-height:1.85;white-space:pre-wrap;color:#d9cba4;background:#05060c}</style></body></html>\n```\n';
const contextFor=(entryId,scopeKey,data)=>({scopeKey,sourceEntryId:entryId,visibleEntryIds:[entryId],chat:[{__liyuanEntryId:entryId,is_user:false,swipe_id:0}],state:{messages:{[entryId]:{variables:[{stat_data:data}]}}}});

test('首楼一致性：完整状态层级、原样式与折叠、MVU只读来源、手机及切支迟到响应隔离', {timeout:60_000}, async()=>{
 const work=await mkdtemp(join(tmpdir(),'liyuan-dossier-firstfloor-'));let browser,server;
 const writes=[],errors=[],external=[];let contextRequests=0,pending=0,delay=false,release;
 let responseContext=contextFor('saved-entry','saved-scope',snapshot);
 const template=process.env.LIYUAN_DOSSIER_FIXTURE?await readFile(process.env.LIYUAN_DOSSIER_FIXTURE,'utf8'):synthetic;assert.ok(template.includes('$1'));
 const skin={rules:[{name:'合成完成卷宗',source:'<UpdateVariable>\\s*([\\s\\S]*?)\\s*</UpdateVariable>',flags:'g',replace:template}],charName:'合成角色',userName:'合成用户'};
 const first='<UpdateVariable><initvar>\n'+stringify(firstState,{lineWidth:0})+'</initvar></UpdateVariable>';
 const latest='合成正文。\n<UpdateVariable>'+source+'</UpdateVariable>';
 try{
  await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{RichContent,ReadOnlyMessagesContext}from'./src/components/Messages.tsx';import{TavernEntryContext}from'./src/components/TavernMessageFrame.tsx';function App(){const[binding,setBinding]=React.useState({entryId:'saved-entry',entryScope:'saved-scope'});const[readOnly,setReadOnly]=React.useState(false);window.__setBinding=setBinding;window.__setReadOnly=setReadOnly;return <div className="flow"><section><p>首楼（合成初始状态）</p><RichContent text={window.__first} skin={window.__skin}/></section><section><p>后续楼（合成已存状态）</p><ReadOnlyMessagesContext.Provider value={readOnly}><TavernEntryContext.Provider value={binding}><RichContent text={window.__latest} skin={window.__skin}/></TavernEntryContext.Provider></ReadOnlyMessagesContext.Provider></section></div>}createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(work,'fixture.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const u=new URL(req.url,'http://localhost');
   if(!['GET','HEAD'].includes(req.method)){writes.push(req.method+' '+u.pathname);res.writeHead(405);return res.end();}
   if(u.pathname==='/api/tavern-plugins/context'){contextRequests++;const data=structuredClone(responseContext),shouldDelay=delay;delay=false;if(shouldDelay){pending++;await new Promise(resolve=>{release=resolve;});pending--;}
    if(!res.destroyed){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}return;
   }
   if(u.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(await readFile(join(work,'fixture.js')));}
   if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f7f4f0;font-family:sans-serif}.flow{max-width:900px;margin:auto;padding:16px}.msg-html-seamless{margin:0;width:100%}.msg-html-frame{display:block;width:100%;border:0;background:transparent}.msg-html-ghost{display:none}</style></head><body><div id="root"></div><script>window.__first=${JSON.stringify(first).replace(/</g,'\\u003c')};window.__latest=${JSON.stringify(latest).replace(/</g,'\\u003c')};window.__skin=${JSON.stringify(skin).replace(/</g,'\\u003c')}</script><script type="module" src="/fixture.js"></script></body></html>`);}
   res.writeHead(404);res.end();
  })().catch(e=>{if(!res.headersSent)res.writeHead(500);res.end(e.message);});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  const binary=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||join(root,'.liyuan-database-plugin/browser/headless_shell');
  const libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS||join(root,'.liyuan-database-plugin/browser-libs/lib64');
  browser=await chromium.launch({headless:true,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,LD_LIBRARY_PATH:libs},args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});page.setDefaultTimeout(10_000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}if(!['GET','HEAD'].includes(route.request().method())){writes.push(route.request().method());return route.abort();}return route.continue();});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const frames=page.locator('iframe.msg-html-frame'),firstFrame=page.frameLocator('iframe.msg-html-frame').nth(0),latestFrame=page.frameLocator('iframe.msg-html-frame').nth(1);
  await latestFrame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});
  assert.equal(await frames.count(),2);assert.equal(await firstFrame.locator('initvar').count(),1,'the reference floor is not changed to a current snapshot');
  const firstText=await firstFrame.locator('initvar').textContent();assert.deepEqual(parse(firstText),firstState);
  assert.deepEqual(parse(await latestFrame.locator('.cxtd-body').textContent()),snapshot);
  assert.equal(await latestFrame.locator('.cxtd-patch-list,.cxtd-source,.cxtd-analysis,h3,analysis,jsonpatch').count(),0,'remove the invented operation-list design');
  assert.equal(await latestFrame.locator('.cxtd-body img').count(),0);
  assert.equal(await page.evaluate(()=>window.__latest),latest,'no author text or patch changes');
  for(const f of [firstFrame,latestFrame]){assert.equal(await f.locator('.cxtd-box > details').getAttribute('open'),null);assert.equal(await f.locator('.cxtd-body').evaluate(el=>getComputedStyle(el).fontSize),'16px');}
  const styleOf=f=>f.locator('.cxtd-body').evaluate(el=>{const s=getComputedStyle(el);return{fontFamily:s.fontFamily,fontSize:s.fontSize,lineHeight:s.lineHeight,color:s.color,padding:s.padding,whiteSpace:s.whiteSpace,background:s.backgroundColor}});
  assert.deepEqual(await styleOf(firstFrame),await styleOf(latestFrame),'the original first-floor typography, padding and colours must match');
  for(const f of [firstFrame,latestFrame])await f.locator('.cxtd-box > details > summary').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].every(f=>f.getBoundingClientRect().height>=f.contentDocument.querySelector('.cxtd-box').getBoundingClientRect().bottom-2));
  const desktopHeight=await frames.nth(1).evaluate(el=>el.getBoundingClientRect().height);assert.ok(desktopHeight>800);
  if(process.env.LIYUAN_DOSSIER_SCREENSHOTS){await mkdir(process.env.LIYUAN_DOSSIER_SCREENSHOTS,{recursive:true});await frames.nth(1).screenshot({path:join(process.env.LIYUAN_DOSSIER_SCREENSHOTS,'firstfloor-format-desktop.png')});}
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].every(f=>f.getBoundingClientRect().height>=f.contentDocument.querySelector('.cxtd-box').getBoundingClientRect().bottom-2));
  assert.deepEqual(await styleOf(firstFrame),await styleOf(latestFrame));assert.equal((await styleOf(latestFrame)).fontSize,'15.5px');
  assert.ok(await latestFrame.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1));
  assert.ok(await latestFrame.locator('.cxtd-box > details').evaluate(el=>el.open));
  const mobileHeight=await frames.nth(1).evaluate(el=>el.getBoundingClientRect().height);await page.waitForTimeout(500);assert.ok(Math.abs(await frames.nth(1).evaluate(el=>el.getBoundingClientRect().height)-mobileHeight)<3);
  if(process.env.LIYUAN_DOSSIER_SCREENSHOTS)await frames.nth(1).screenshot({path:join(process.env.LIYUAN_DOSSIER_SCREENSHOTS,'firstfloor-format-mobile.png')});
  await latestFrame.locator('.cxtd-box > details > summary').click();await page.waitForFunction(()=>document.querySelectorAll('iframe')[1].getBoundingClientRect().height<200);
  // An isolated record preview cannot fetch production native variables even if it has stale context props.
  await page.evaluate(()=>window.__setReadOnly(true));await latestFrame.locator('jsonpatch').waitFor({state:'attached'});const reads=contextRequests;await page.waitForTimeout(300);assert.equal(contextRequests,reads);
  await page.evaluate(()=>window.__setReadOnly(false));await latestFrame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});
  // A slow previous branch must not overwrite a newly bound floor after its fetch resolves.
  responseContext=contextFor('slow-entry','slow-scope',{过期状态:'不能显示'});delay=true;
  await page.evaluate(()=>window.__setBinding({entryId:'slow-entry',entryScope:'slow-scope'}));
  for(let i=0;i<100&&!pending;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pending,1);
  const fresh={主角状态:{测试值:300},世界系统:{当前时间:'新分支'},人际交往:{}};
  responseContext=contextFor('fresh-entry','fresh-scope',fresh);
  await page.evaluate(()=>window.__setBinding({entryId:'fresh-entry',entryScope:'fresh-scope'}));
  await latestFrame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});assert.deepEqual(parse(await latestFrame.locator('.cxtd-body').textContent()),fresh);
  release();await page.waitForTimeout(300);assert.deepEqual(parse(await latestFrame.locator('.cxtd-body').textContent()),fresh);
  assert.deepEqual(parse(await firstFrame.locator('initvar').textContent()),firstState);
  // No exact-message saved data means an explicit unavailable state, not a reused latest/first-floor snapshot.
  responseContext=contextFor('missing-entry','missing-scope',null);
  await page.evaluate(()=>window.__setBinding({entryId:'missing-entry',entryScope:'missing-scope'}));
  await latestFrame.locator('[data-liyuan-dossier-view="unavailable"]').waitFor({state:'attached'});
  assert.match(await latestFrame.locator('.cxtd-body').textContent(),/未代用其他楼层数据/);
  // Author-ready may arrive long before derived settlement. A source-bound read
  // refresh must work even without waiting for another timer or reloading scripts.
  const beforeRefresh=contextRequests;
  responseContext=contextFor('missing-entry','missing-scope',snapshot);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail:{entryId:'other-entry',entryScope:'missing-scope'}})));
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail:{entryId:'missing-entry',entryScope:'other-scope'}})));
  await page.waitForTimeout(100);assert.equal(contextRequests,beforeRefresh,'other entry/scope refreshes must not fetch');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail:{entryId:'missing-entry',entryScope:'missing-scope'}})));
  await latestFrame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});
  assert.deepEqual(parse(await latestFrame.locator('.cxtd-body').textContent()),snapshot);
  assert.ok(contextRequests>beforeRefresh);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(snapshot.人际交往.道友录.合成人物.好感,42);
  console.log('first-floor dossier geometry',JSON.stringify({desktopHeight,mobileHeight,rootGroups:3,contextRequests,externalRequestsBlocked:external.length,originalTemplate:!!process.env.LIYUAN_DOSSIER_FIXTURE}));
 }finally{release?.();await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(work,{recursive:true,force:true});}
});
