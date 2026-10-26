import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';

const root=resolve(new URL('../..',import.meta.url).pathname);
test('actual App supplementary action: fee confirmation, exact CAS payload, cancel and mobile', {timeout:60000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liyuan-supplementary-ui-'));
 let server,browser,respond;const requests=[],errors=[],external=[];
 try{
  // Compile the actual App JSX action, not a test reimplementation of its handler.
  const app=await readFile(join(root,'web/src/App.tsx'),'utf8');
  const end=app.indexOf('}>重新生成附属</button>');
  assert.ok(end>0);
  const start=app.lastIndexOf('<button',end),action=app.slice(start,end+'}>重新生成附属</button>'.length);
  await build({stdin:{contents:`import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';import{apiPost}from'./src/api.ts';
   function Fixture(){const[busy,setBusy]=useState(false),[settlementRetrying,setSettlementRetrying]=useState(false),[notice,setNotice]=useState('');
   const sessionIdRef=useRef('synthetic-session'),[messages,setMessages]=useState([{channel:'narrative',entryId:'synthetic-source',text:'SYNTHETIC STORY',supplementaryDelivery:{status:'complete',version:2,receiptHash:'a'.repeat(64)}}]);
   window.fixtureBusy=setBusy;window.fixtureMessages=setMessages;const pushToast=(_,text)=>setNotice(text);
   return <><section className="turn-management">${action}</section><p role="status">{notice}</p><pre>SYNTHETIC UNCHANGED AUTHOR</pre></>;
   }createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(dir,'app.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   if(req.method==='POST'){
    let raw='';for await(const part of req)raw+=part;
    requests.push({path:req.url,body:JSON.parse(raw)});
    respond=(status,body)=>{respond=undefined;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};return;
   }
   if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(join(dir,'app.js')));return;}
   res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH}});
  for(const width of [1280,390]){
   const context=await browser.newContext({viewport:{width,height:900}});
   await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
   const button=page.getByRole('button',{name:'重新生成附属',exact:true});await button.waitFor();const before=requests.length;
   page.once('dialog',async dialog=>{assert.match(dialog.message(),/可能产生模型费用/);assert.match(dialog.message(),/原稿和历史收据保留/);await dialog.dismiss();});
   await button.click();await page.waitForTimeout(100);assert.equal(requests.length,before);
   page.once('dialog',dialog=>dialog.accept());await button.click();await page.waitForFunction(()=>document.querySelector('button').disabled);
   for(let i=0;requests.length===before;i++){assert.ok(i<100);await page.waitForTimeout(10);}
   assert.deepEqual(requests.at(-1),{path:'/api/turn/regenerate-supplementary',body:{expectedSessionId:'synthetic-session',expectedSourceEntryId:'synthetic-source',expectedReceiptHash:'a'.repeat(64)}});
   await button.evaluate(node=>{node.click();node.click();});await page.waitForTimeout(80);assert.equal(requests.length,before+1);
   respond(409,{error:'SYNTHETIC STALE RECEIPT'});await page.getByRole('status').filter({hasText:'SYNTHETIC STALE RECEIPT'}).waitFor();assert.equal(await button.isEnabled(),true);
   await page.evaluate(()=>window.fixtureBusy(true));await page.waitForFunction(()=>document.querySelector('button').disabled);assert.equal(await button.isDisabled(),true);
   await page.evaluate(()=>window.fixtureBusy(false));await page.waitForFunction(()=>!document.querySelector('button').disabled);
   page.once('dialog',dialog=>dialog.accept());await button.click();
   for(let i=0;requests.length<before+2;i++){assert.ok(i<100);await page.waitForTimeout(10);}
   respond(200,{aborted:false});await page.getByRole('status').filter({hasText:'附属已重新生成，原稿未改动'}).waitFor();
   assert.equal(await page.locator('pre').innerText(),'SYNTHETIC UNCHANGED AUTHOR');assert.equal(await button.isEnabled(),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{respond?.(503,{error:'cleanup'});await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(dir,{recursive:true,force:true});}
});
