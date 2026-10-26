import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('desktop/mobile merged preparation is one output row and prior failed candidates remain readable',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liyuan-merged-output-'));let server,browser;
 try{
  console.log('merged fixture: build');
  await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PerformanceRows,NpcParallelViews}from'./src/components/Messages.tsx';import './src/app.css';
   const phases={'prep.database':{durationMs:2100,calls:2,status:'success',usageCalls:2,inputTokens:500,outputTokens:90},'prep.director':{durationMs:0,calls:0,status:'skipped',reason:'merged-database-recall'},'prep.memoryRecall':{durationMs:0,calls:0,status:'skipped'},'prep.memoryArcs':{durationMs:0,calls:0,status:'skipped'}};
   const entry={id:'old',hash:'old',actorId:'actor',name:'合成人物',text:'SYNTHETIC COMPLETE CANDIDATE END',info:'SYNTHETIC INFO END',status:'rejected',reason:'schema format failure',eventIds:[]};
   createRoot(document.getElementById('root')).render(<><PerformanceRows performance={{version:1,narrativeEntryId:'story',totalMs:3000,phases,callsScope:'harness-attempts',providerRetries:'unknown'}}/><NpcParallelViews receipt={{version:1,sourceEntryId:'story',upstreamCommit:'a'.repeat(40),upstreamVersion:'fixture',calls:2,status:'failed',reason:'quota exceeded',entries:[],retainedEntries:[entry]}}/></>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(dir,'app.js'),logLevel:'silent',loader:{'.woff2':'dataurl','.png':'dataurl'}});
  console.log('merged fixture: built');
  server=createServer(async(req,res)=>{const asset=req.url==='/app.js'?'app.js':req.url==='/app.css'?'app.css':null;res.writeHead(200,{'content-type':asset?.endsWith('.js')?'text/javascript':asset?'text/css':'text/html'});res.end(asset?await readFile(join(dir,asset)):'<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><main id="root" style="max-width:100%;padding:12px"></main><script type="module" src="/app.js"></script></body></html>')});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  console.log('merged fixture: launch');
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});
  console.log('merged fixture: launched');
  for(const width of [1280,390]){
   console.log('merged fixture: page',width);const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
   console.log('merged fixture: loaded',width);await page.locator('strong[title="prep.recallDirector"]').waitFor();assert.equal(await page.locator('strong[title="prep.recallDirector"]').count(),1);assert.equal(await page.locator('strong[title="prep.director"]').count(),0);assert.equal(await page.locator('strong[title="prep.memoryRecall"]').count(),0);
   await page.locator('.npc-parallel-views > summary').click();await page.locator('.npc-retained-candidates > summary').click();await page.locator('.npc-retained-candidates details > summary').click();
   await page.getByText('SYNTHETIC COMPLETE CANDIDATE END',{exact:true}).waitFor({state:'visible'});await page.getByText('SYNTHETIC INFO END',{exact:true}).waitFor({state:'visible'});assert.match(await page.locator('.npc-parallel-views').innerText(),/本次生成候选 0 份 · 已采纳 0 份/);
   await page.locator('.npc-retained-candidates details > summary').click();assert.equal(await page.getByText('SYNTHETIC COMPLETE CANDIDATE END',{exact:true}).isVisible(),false);await page.locator('.npc-parallel-views > summary').click();assert.deepEqual(errors,[]);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.close();
  }
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok))}await rm(dir,{recursive:true,force:true})}
});
