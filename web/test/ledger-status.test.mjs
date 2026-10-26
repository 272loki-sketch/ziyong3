import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm}from'node:fs/promises';
import{createServer}from'node:http';
import{tmpdir}from'node:os';
import{join,resolve}from'node:path';
import test from'node:test';
import{build}from'../node_modules/esbuild/lib/main.js';
import{chromium}from'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('ledger detail stays inside overlay, compact failure status, review and mobile geometry',{timeout:90000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-ledger-browser-'));let browser,server;const errors=[],external=[],posts=[],puts=[];let stale=true;
 const source=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{StatusStrip}from'./src/components/StatusStrip.tsx';
const initial={time:'合成日期',location:'合成车站',characters:{合成人物:{affinity:0,status:'等候',notes:''}},inventory:[],flags:{},plot_threads:[]};
const blocked={status:'blocked',sourceEntryId:'source',revision:'rev1',canConfirm:true,message:'本轮自动记账被供应商安全策略拒绝，当前账本尚未跟上最新剧情。旧快照与用户编辑保留；不会自动换模型或重试。'};
function App(){const[state,setState]=useState(initial),[ledger,setLedger]=useState(blocked),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');window.fixtureFrame=(frame)=>{if(frame.state)setState(frame.state);setLedger(frame.ledgerStatus??null)};window.fixtureBusy=setBusy;return <><StatusStrip state={state} ledgerStatus={ledger} ledgerScope={{sessionId:'fixture',card:'fixture.json'}} busy={busy} toast={(_,text)=>setNotice(text)}/><p id="notice">{notice}</p></>};createRoot(document.getElementById('root')).render(<App/>);`;
 try{
  await build({stdin:{contents:source,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname;res.setHeader('content-type','application/json');
   if(req.method==='PUT'&&path==='/api/state'){let raw='';for await(const chunk of req)raw+=chunk;puts.push(JSON.parse(raw));return res.end(JSON.stringify({applied:['location'],warnings:[]}));}
   if(req.method==='POST'&&path==='/api/state/confirm-ledger'){let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);posts.push(body);if(stale){res.statusCode=409;return res.end(JSON.stringify({error:'合成账本版本已变化，请刷新后确认'}))}return res.end(JSON.stringify({applied:[],warnings:[]}));}
   if(req.method!=='GET'){res.statusCode=405;return res.end('{}')}
   if(path==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')))}
   if(path==='/fixture.css'){res.setHeader('content-type','text/css');return res.end(await readFile(join(root,'web/src/app.css')))}
   if(path==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>#root{display:block;max-width:800px;margin:650px auto 0;width:100%;height:auto}</style></head><body><div id="root" ></div><script type="module" src="/fixture.js"></script></body></html>')}
   res.statusCode=404;res.end('{}');
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.LIYUAN_LEDGER_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_LEDGER_BROWSER_EXECUTABLE}:{}),...(process.env.LIYUAN_LEDGER_BROWSER_LIBS?{env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_LEDGER_BROWSER_LIBS}}:{})});const context=await browser.newContext({viewport:{width:1280,height:900}});await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort()}return route.continue()});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);const notice=page.locator('.ledger-sync-notice'),confirm=page.getByRole('button',{name:'已核对整份账本，确认本轮'});await page.locator('.status-strip-bar').waitFor();assert.equal(await notice.count(),0);assert.equal(await page.locator('.status-card').count(),0);assert.match(await page.locator('.ledger-summary-status').innerText(),/账本待补/);await page.locator('.status-strip-bar').click();await notice.waitFor();assert.match(await notice.innerText(),/未跟上最新剧情/);assert.equal(await page.locator('.status-card .ledger-sync-notice').count(),1);
  await page.locator('.status-card').waitFor();await page.locator('.status-card .kv').nth(1).getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.status-card input').fill('合成图书室');await page.locator('.status-card input').press('Enter');await page.waitForTimeout(100);assert.deepEqual(puts,[{patch:{location:'合成图书室'}}]);assert.equal(posts.length,0);assert.equal(await notice.count(),1,'partial edit must not claim full ledger settlement');
  page.once('dialog',d=>d.dismiss());await confirm.click();assert.equal(posts.length,0,'cancel does not confirm or call a model');page.once('dialog',d=>d.accept());await confirm.click();await page.getByText('合成账本版本已变化，请刷新后确认',{exact:true}).waitFor();assert.equal(posts.length,1);assert.equal(posts[0].confirm,true);assert.deepEqual(posts[0].expected,{sessionId:'fixture',card:'fixture.json',sourceEntryId:'source',revision:'rev1'});assert.equal(await notice.count(),1);
  await page.evaluate(()=>window.fixtureBusy(true));assert.equal(await confirm.isDisabled(),true);await page.evaluate(()=>window.fixtureBusy(false));stale=false;page.once('dialog',d=>d.accept());await confirm.click();await page.getByText('本轮账本已由用户核对确认',{exact:true}).waitFor();assert.equal(posts.length,2);
  const blocked={status:'blocked',sourceEntryId:'source',revision:'rev2',canConfirm:true,message:'本轮自动记账被供应商安全策略拒绝，当前账本尚未跟上最新剧情。'};
  for(const width of[1280,390,320]){await page.setViewportSize({width,height:900});await page.evaluate(ledgerStatus=>window.fixtureFrame({ledgerStatus}),blocked);assert.equal(await notice.count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const strip=page.locator('.status-strip'),bar=page.locator('.status-strip-bar'),header=await bar.boundingBox(),opened=await strip.boundingBox();assert.ok(Math.abs(header.height-opened.height)<1);await bar.click();assert.equal(await notice.count(),0);assert.equal(await page.getByRole('button',{name:'已核对整份账本，确认本轮'}).count(),0);assert.equal(await page.getByRole('button',{name:'补写账本',exact:true}).count(),0);const closed=await strip.boundingBox();assert.ok(Math.abs(header.height-closed.height)<1);await bar.click();await notice.waitFor()}
  await page.evaluate(()=>window.fixtureFrame({ledgerStatus:{status:'current',canConfirm:false,message:'账本已由用户核对确认'}}));await notice.waitFor({state:'detached'});assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(puts.length,1);assert.equal(posts.length,2);
 }finally{await browser?.close();if(server)await new Promise(ok=>server.close(ok));await rm(cwd,{recursive:true,force:true})}
});
