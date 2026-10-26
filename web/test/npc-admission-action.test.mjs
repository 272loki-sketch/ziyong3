import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{createServer}from'node:http';import{build}from'../node_modules/esbuild/lib/main.js';import{chromium}from'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('saved-candidate action submits only exact bindings/hashes once, reports rejection, and disables stale workspace',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liyuan-npc-admission-ui-'));let server,browser,release;const requests=[];
 try{
  await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{NpcParallelViews}from'./src/components/Messages.tsx';window.__liyuanWorkspaceScope={stale:false};const entry={id:'candidate',hash:'a'.repeat(64),actorId:'actor',name:'合成',text:'SYNTHETIC SAVED TEXT',status:'rejected',reason:'schema format failure',eventIds:[]};createRoot(document.getElementById('root')).render(<NpcParallelViews receipt={{version:1,sessionId:'synthetic-session',sourceEntryId:'story',upstreamCommit:'a'.repeat(40),upstreamVersion:'fixture',calls:2,status:'failed',entries:[],retainedEntries:[entry]}}/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(dir,'app.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(await readFile(join(dir,'app.js')))}
   if(req.method==='POST'&&req.url==='/api/turn/retry-npc-admission'){let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));await new Promise(ok=>{release=ok});res.writeHead(200,{'content-type':'application/json'});return res.end('{"aborted":false,"error":"SYNTHETIC INTAKE FAILURE"}')}
   res.writeHead(200,{'content-type':'text/html'});res.end('<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(12000);await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});await page.locator('.npc-parallel-views > summary').click();
   const button=page.getByRole('button',{name:'复用已有侧写，仅补采纳',exact:true}),before=requests.length;await button.click();await page.getByRole('button',{name:'正在补办采纳…'}).waitFor();assert.equal(await page.getByRole('button',{name:'正在补办采纳…'}).isDisabled(),true);await page.getByRole('button',{name:'正在补办采纳…'}).evaluate(n=>{n.click();n.click()});
   for(let i=0;requests.length===before;i++){if(i>100)throw Error('No admission request');await page.waitForTimeout(10)}
   assert.equal(requests.length,before+1);assert.deepEqual(requests.at(-1),{expectedSessionId:'synthetic-session',expectedSourceEntryId:'story',candidateHashes:['a'.repeat(64)]});assert.doesNotMatch(JSON.stringify(requests),/SYNTHETIC SAVED TEXT/);
   release();await page.getByRole('alert').filter({hasText:'SYNTHETIC INTAKE FAILURE'}).waitFor();await page.evaluate(()=>window.dispatchEvent(new Event('liyuan:workspace-changed')));assert.equal(await button.count(),0);await page.close();
  }
 }finally{release?.();await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok))}await rm(dir,{recursive:true,force:true})}
});
