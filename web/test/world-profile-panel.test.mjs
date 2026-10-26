import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('world profile panel: failure visible, retry/progress/success refresh, disabled world can still analyze, source refresh and mobile (synthetic)',{timeout:90000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-world-panel-'));let server,browser;
 const errors=[],external=[];let profile=null,attempts=0,fail=true,released,worldEnabled=false;
 const fullProfile={revision:4,analyzedTurns:6,digest:'合成画像已经保存',labels:['合成'],primaryScale:'scene',defaultTimeStep:'scene',worldActivity:'normal',modules:[],disabledModules:[],userRequirements:['保留合成要求'],optimizationNotes:[],unresolvedQuestions:[],status:'draft'};
 try{
  await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{WorldProfileSection}from'./src/components/WorldProfileSection.tsx';import{PanelRefreshContext}from'./src/components/kit.tsx';function App(){const[t,setT]=useState(0);return <><button onClick={()=>setT(t+1)}>合成会话刷新</button><PanelRefreshContext.Provider value={t}><WorldProfileSection enabled={false} toast={()=>{}}/></PanelRefreshContext.Provider></>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
   if(url.pathname==='/api/world-profile'&&req.method==='GET')return res.end(JSON.stringify({card:{name:'合成卡',key:'fixture'},profile,materialsChanged:false,worldEnabled}));
   if(url.pathname==='/api/world-profile/analyze'){
    attempts++;await new Promise(r=>{released=r});
    if(fail){res.statusCode=400;return res.end(JSON.stringify({error:'合成模型不可用：请检查画像岗位连接'}));}
    profile={...fullProfile};return res.end(JSON.stringify({ok:true,profile,manifestApplied:true}));
   }
   if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')));}
   if(url.pathname==='/app.css'){res.setHeader('content-type','text/css');return res.end(await readFile(join(root,'web/src/app.css')));}
   if(url.pathname==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div style="max-width:700px;margin:auto;padding:12px" id="root"></div><script type="module" src="/fixture.js"></script></body></html>');}
   res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  const analyze=page.getByRole('button',{name:'分析这张卡',exact:true});await analyze.waitFor();assert.equal(await analyze.isEnabled(),true);
  assert.match(await page.locator('body').textContent(),/世界推演当前未启用/);
  await analyze.click();await page.getByText('正在分析角色卡与启用资料', {exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'正在分析…'}).isDisabled(),true);
  assert.equal(attempts,1);released();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/合成模型不可用/);
  fail=false;await page.getByRole('button',{name:'分析这张卡',exact:true}).click();await page.getByRole('button',{name:'正在分析…'}).waitFor();released();
  await page.getByText('合成画像已经保存',{exact:true}).waitFor();assert.equal(await page.getByRole('alert').count(),0);
  assert.match(await page.locator('body').textContent(),/画像 v4 已生成并用于当前分支/);assert.match(await page.locator('body').textContent(),/已复盘至第 6 拍/);
  await page.reload();await page.getByText('合成画像已经保存',{exact:true}).waitFor();
  profile={...fullProfile,revision:5,digest:'另一个合成分支的画像'};await page.getByRole('button',{name:'合成会话刷新'}).click();await page.getByText('另一个合成分支的画像',{exact:true}).waitFor();
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(attempts,2);
 }finally{released?.();await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});}
});
