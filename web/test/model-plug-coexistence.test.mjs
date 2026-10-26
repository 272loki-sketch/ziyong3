import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
import { AuthStorage, ModelRegistry } from '@liyuan/agent-runtime';
import { handleApiRequest } from '../../server/rest.ts';
import { loadAgentConfig, saveAgentConfig, saveProfile, syncAgentConfigToRuntime } from '../../src/agent-config.ts';
import { configuredModels } from '../../src/configured-models.ts';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('switching/refreshing the main profile keeps old API plugs live in the selector and actual catalog (synthetic)',{timeout:90000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-model-plug-coexist-')),agentDir=join(cwd,'agent');let server,browser;const errors=[];
 const provider=id=>({baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'SYNTHETIC-NOT-A-REAL-KEY',models:[{id,name:id,input:['text'],maxTokens:4096,contextWindow:128000}]});
 const initial={version:1,defaultProvider:'old',defaultModel:'flash',providers:{old:provider('flash')}};
 saveAgentConfig(cwd,initial);saveProfile(cwd,'old','old',initial);saveProfile(cwd,'main','main',{version:1,defaultProvider:'main',defaultModel:'writer',providers:{main:provider('writer')}});saveProfile(cwd,'unused','unused',{version:1,providers:{unused:provider('not-enabled')}});syncAgentConfigToRuntime(cwd,agentDir,initial);
 const registry=ModelRegistry.create(AuthStorage.inMemory(),join(agentDir,'models.json'));let current={provider:'old',id:'flash',name:'flash',thinkingLevel:'off',availableLevels:['off']};
 const host={cwd,agentDir:()=>agentDir,isStreaming:()=>false,refreshModels:()=>registry.refresh(),selectModel:async(provider,id)=>{current={...current,provider,id,name:id};return current},notify:()=>{},listModels:()=>({current,models:configuredModels(registry.getAvailable(),loadAgentConfig(cwd).config).map(m=>({provider:m.provider,providerName:m.provider,id:m.id,name:m.name,reasoning:false,vision:false,contextWindow:m.contextWindow,maxTokens:m.maxTokens}))})};
 try{
  await build({stdin:{contents:`import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import{ModelPlugSelector}from'./src/components/ModelPlugSelector.tsx';function App(){const[c,setC]=useState(null);const load=()=>fetch('/api/models/catalog').then(r=>r.json()).then(setC);useEffect(()=>{load()},[]);async function change(action){const r=await fetch('/api/agent-profiles/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'main'})});if(!r.ok)throw Error('synthetic activation failed');await load()}return <><span data-current>{c?.current?.provider}</span><button onClick={()=>change('enable')}>切换主用渠道</button><button onClick={()=>change('refresh')}>刷新主用渠道</button><ModelPlugSelector label="世界画像岗位" value={{provider:'old',id:'flash'}} models={c} onChange={()=>{}}/></>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{try{
   if(req.url.startsWith('/api/'))return await handleApiRequest(req,res,host);
   if(req.url==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')))}
   if(req.url==='/app.css'){res.setHeader('content-type','text/css');return res.end(await readFile(join(root,'web/src/app.css')))}
   res.setHeader('content-type','text/html');res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body style="padding:12px"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  }catch(e){res.statusCode=500;res.end('synthetic fixture failure')}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('[data-current]')?.textContent==='old');
  const selector=page.getByLabel('世界画像岗位',{exact:true});assert.equal(await selector.inputValue(),'old:flash');
  await page.getByRole('button',{name:'切换主用渠道'}).click();await page.waitForFunction(()=>document.querySelector('[data-current]')?.textContent==='main');
  assert.equal(await selector.inputValue(),'old:flash');assert.doesNotMatch(await selector.locator('option:checked').textContent(),/已失效/);assert.equal(await selector.locator('optgroup').count(),2);
  await page.getByRole('button',{name:'刷新主用渠道'}).click();await page.waitForTimeout(150);assert.equal(await selector.inputValue(),'old:flash');assert.equal(await selector.locator('option').filter({hasText:'已失效'}).count(),0);
  const cfg=loadAgentConfig(cwd).config;assert.equal(cfg.defaultProvider,'main');assert.ok(cfg.providers.old);assert.equal(cfg.providers.unused,undefined);
  await page.reload();await page.waitForFunction(()=>document.querySelector('[data-current]')?.textContent==='main');assert.equal(await selector.inputValue(),'old:flash');assert.equal(await selector.locator('option').filter({hasText:'已失效'}).count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true})}
});
