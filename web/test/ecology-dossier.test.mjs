import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:http';
import test from 'node:test';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
import {ecologyWireView, literaryEcologyFromBranch} from '../../src/stage/literary-ecology.ts';

const root = resolve(new URL('../..', import.meta.url).pathname);
test('synthetic ecology dossier groups history and exposes stale sources on desktop and mobile', {timeout: 90000}, async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'liyuan-ecology-dossier-'));
 let browser, server;
 try {
  const base={version:1,round:1,digest:'第一天合成快照',actors:[],locationStates:[],recentPatterns:[],recentUses:[],secrets:[],occurrences:[...Array.from({length:3},(_,i)=>({id:'old-'+i,name:'第一天历史-'+i,patternKey:'old-'+i,status:i===2?'expired':'resolved',visibility:'public'})),...Array.from({length:5},(_,i)=>({id:'new-'+i,name:'第七天活动-'+i,patternKey:'new-'+i,status:i===4?'scheduled':'active',visibility:'public'}))]};
  const branch=[{type:'custom',id:'eco-old',customType:'rp-ecology-state',data:{...base,_diagnosticSourceEntryId:'day-one'}},{id:'day-seven',message:{role:'assistant',details:{rpNarrative:'合成一周后正文'}}},{customType:'rp-turn-settlement',data:{narrativeEntryId:'day-seven',status:'pending',ecologyDone:false}}];
  const failed=ecologyWireView(literaryEcologyFromBranch(branch),branch);
  branch.at(-1).data.status='settling';
  // Reload persisted settling without any live engine, as after cancellation/restart.
  const reloadedBranch=JSON.parse(JSON.stringify(branch));
  const pending=ecologyWireView(literaryEcologyFromBranch(reloadedBranch),reloadedBranch);
  const discoveryBranch=[{...branch[0],data:{...branch[0].data,occurrences:[...base.occurrences.slice(0,3),{id:'discovery',name:'第七天可探索活动',patternKey:'discovery',status:'active',visibility:'discoverable'}]}},branch[1],{...branch[2],data:{...branch[2].data,status:'pending'}}];
  const discovery=ecologyWireView(literaryEcologyFromBranch(discoveryBranch),discoveryBranch);
  await build({stdin:{resolveDir:join(root,'web'),loader:'tsx',contents:`
import React from 'react';import{createRoot}from'react-dom/client';import './src/app.css';
import{EcologyStateCard}from'./src/components/Messages.tsx';
const failed=${JSON.stringify(failed)},pending=${JSON.stringify(pending)},discovery=${JSON.stringify(discovery)};
function App(){const[ecology,setEcology]=React.useState(failed);return <main style={{maxWidth:900,margin:'auto',padding:12}}><button onClick={()=>setEcology(pending)}>合成重启后遗留收据</button><button onClick={()=>setEcology(discovery)}>合成仅可探索新事件</button><EcologyStateCard ecology={ecology}/></main>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,jsx:'automatic',format:'esm',platform:'browser',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const file={'/fixture.js':'fixture.js','/fixture.css':'fixture.css'}[req.url];
   if(file){res.setHeader('content-type',file.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(join(cwd,file)));return;}
   if(req.url!=='/'){res.writeHead(404).end();return;}
   res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.LIYUAN_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_TEST_BROWSER_EXECUTABLE}:{}),...(process.env.LIYUAN_TEST_BROWSER_LIBS?{env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_TEST_BROWSER_LIBS}}:{})});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:900});await page.goto(origin);
   const card=page.locator('.turn-dossier');await card.locator(':scope > summary').click();
   assert.match(await card.innerText(),/最近已提交快照/);
   assert.match(await card.getByRole('status').innerText(),/本轮生态尚未更新，暂时显示上次结果/);
   assert.doesNotMatch(await card.innerText(),/快照正文来源|生态条目：|最新正文：|day-one|day-seven|eco-old/);
   const current=card.locator('.world-state-section').filter({hasText:'进行中 / 待发生'});
   assert.equal(await current.locator('li').count(),5);assert.doesNotMatch(await current.innerText(),/第一天历史/);
   const history=card.locator('.ecology-history');assert.equal(await history.getAttribute('open'),null);
   await history.locator('summary').click();assert.equal(await history.locator('li').count(),3);
   assert.match(await history.innerText(),/第一天历史-2｜expired/);
   await history.locator('summary').click();assert.equal(await history.getAttribute('open'),null);
   await page.getByRole('button',{name:'合成重启后遗留收据'}).click();
   assert.match(await card.getByRole('status').innerText(),/本轮生态尚未更新，暂时显示上次结果/);
   assert.doesNotMatch(await card.getByRole('status').innerText(),/正在|恢复中|整理中/);
   await page.getByRole('button',{name:'合成仅可探索新事件'}).click();
   assert.match(await current.innerText(),/此快照没有进行中或待发生的公开事件/);
   const discovered=card.locator('details.ecology-discovered').filter({hasText:'可探索信息'});
   await discovered.locator('summary').click();assert.match(await discovered.innerText(),/第七天可探索活动/);
   assert.doesNotMatch(await current.innerText(),/第七天可探索活动/);
   assert.equal(await history.locator('li').count(),3);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await card.locator(':scope > summary').click();assert.equal(await card.getAttribute('open'),null);
  }
  assert.deepEqual(errors,[]);
 } finally {await browser?.close();if(server)await new Promise(ok=>server.close(ok));await rm(cwd,{recursive:true,force:true});}
});
