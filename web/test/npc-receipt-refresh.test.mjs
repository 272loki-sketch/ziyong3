import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('NPC receipt invalidates stale live state, preserves draft reload flow and follows authoritative recovery',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liyuan-npc-receipt-'));let browser,server;
 try{
  await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{NpcParallelViews}from'./src/components/Messages.tsx';const root=createRoot(document.getElementById('root'));window.renderReceipt=status=>root.render(<NpcParallelViews receipt={{version:1,status,sourceEntryId:'synthetic-reply',upstreamVersion:'synthetic',upstreamCommit:'a'.repeat(40),calls:1,reason:status==='failed'?'SYNTHETIC OLD FAILURE':'',entries:[]}}/>);window.__liyuanWorkspaceScope={stale:false};window.reloads=0;window.addEventListener('liyuan:request-workspace-reload',()=>window.reloads++);window.renderReceipt('failed');`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:join(dir,'app.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{if(req.url==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(join(dir,'app.js')));}else{res.writeHead(200,{'content-type':'text/html'});res.end('<html><body><textarea id="draft">SYNTHETIC UNSENT DRAFT</textarea><div id="root"></div><script type="module" src="/app.js"></script></body></html>');}});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
   await page.getByText('接入未完成',{exact:true}).waitFor();
   await page.evaluate(()=>{window.__liyuanWorkspaceScope.stale=true;window.dispatchEvent(new Event('liyuan:workspace-changed'));});
   await page.getByText('收据已过期，需刷新核对',{exact:true}).waitFor();assert.equal(await page.getByText('接入未完成',{exact:true}).count(),0);
   await page.locator('.npc-parallel-views > summary').click();await page.getByRole('button',{name:'保留草稿并刷新结算状态'}).click();assert.equal(await page.evaluate(()=>window.reloads),1);assert.equal(await page.locator('#draft').inputValue(),'SYNTHETIC UNSENT DRAFT');assert.equal(await page.getByRole('alert').count(),0);
   await page.reload({waitUntil:'domcontentloaded'});await page.getByText('接入未完成',{exact:true}).waitFor();await page.evaluate(()=>window.renderReceipt('accepted'));await page.getByText('鲜活世界已采纳',{exact:true}).waitFor();assert.equal(await page.getByText('接入未完成',{exact:true}).count(),0);await page.close();
  }
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(dir,{recursive:true,force:true});}
});
