// Only synthetic React messages and local fixture resources; no server/model calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

test('author failure remains visible on normal and full-page card bubbles, while complete prose has no failure alert', {timeout:45000},async()=>{
 const root=resolve(new URL('../..',import.meta.url).pathname),cwd=await mkdtemp(join(tmpdir(),'liyuan-author-recovery-ui-'));
 let server,browser;const errors=[],requests=[];
 try{
  const source=`import React from 'react';import{createRoot}from'react-dom/client';import{Bubble}from${JSON.stringify(join(root,'web/src/components/Messages.tsx'))};const base={channel:'narrative',name:'合成角色',generationMode:'director'};createRoot(document.getElementById('root')).render(<><Bubble fallbackName="合成角色" msg={{...base,id:'ordinary',text:'合成半稿',unfinished:true,generationError:'补全回执无效'}}/><Bubble fallbackName="合成角色" msg={{...base,id:'full',text:'<!doctype html><html><head></head><body><main>合成整页角色卡半稿</main></body></html>',unfinished:true,generationError:'两次校验未通过'}}/><Bubble fallbackName="合成角色" msg={{...base,id:'complete',text:'合成完整正文。'}}/></>);`;
  await build({stdin:{contents:source,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:join(cwd,'fixture.js'),loader:{'.css':'empty'},logLevel:'silent'});
  await writeFile(join(cwd,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  await writeFile(join(cwd,'fixture.css'),await readFile(join(root,'web/src/app.css')));
  server=createServer((req,res)=>{const name=req.url?.split('?')[0];requests.push(name);if(!['/','/fixture.js','/fixture.css'].includes(name)){res.writeHead(404);res.end();return;}void readFile(join(cwd,name==='/'?'index.html':name.slice(1))).then(data=>{res.writeHead(200,{'content-type':name?.endsWith('.js')?'application/javascript':name?.endsWith('.css')?'text/css':'text/html'});res.end(data)});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS||process.env.LD_LIBRARY_PATH||''},args:process.getuid?.()===0?['--no-sandbox']:[]});
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin,{waitUntil:'domcontentloaded'});await page.locator('.generation-failure-note').first().waitFor();
  assert.equal(await page.locator('.generation-failure-note').count(),2);assert.equal(await page.locator('.msg-stage .generation-failure-note').count(),1);
  for(const note of await page.locator('.generation-failure-note').all()){assert.equal(await note.isVisible(),true);assert.match(await note.innerText(),/本拍正文未完成/);}
  await page.setViewportSize({width:390,height:844});
  for(const note of await page.locator('.generation-failure-note').all())assert.equal(await note.isVisible(),true);
  assert.deepEqual(errors,[]);assert.ok(!requests.some(r=>/generate|completion|prompt/.test(r??'')));
  console.log('PASS synthetic desktop/mobile: author error outside full-page card header, no model or story write requests');
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});}
});
