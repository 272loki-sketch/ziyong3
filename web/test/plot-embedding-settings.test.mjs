import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('embedding connection is editable/savable while old memory is off; no model probe or memory enable side effect', {timeout:60000}, async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-plot-embed-settings-')); let server,browser; const writes=[],errors=[];
 let config={enabled:false,searchTopK:5,injectOnTurn:false,embedMode:'local',cloudEmbed:{baseUrl:'http://127.0.0.1:9/v1',apiKey:'',model:'synthetic-old'},cloudEmbedConfigured:false,stores:[]};
 try{
  await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{MemorySection}from'./src/components/SettingsPanel.tsx';createRoot(document.getElementById('root')).render(<MemorySection toast={()=>{}}/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const u=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
   if(u.pathname==='/api/memory'&&req.method==='GET')return res.end(JSON.stringify({config,stores:[],scope:{sessionId:'synthetic-session'}}));
   if(u.pathname==='/api/memory'&&req.method==='PUT'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);writes.push(body);config={...config,...body};return res.end(JSON.stringify({config,stores:[]}));}
   if(u.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')));}
   if(u.pathname==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="max-width:700px;margin:auto"></div><script type="module" src="/fixture.js"></script></body></html>');}
   res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.LIYUAN_PLOT_BROWSER_LIBS?{env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_PLOT_BROWSER_LIBS}}:{})});const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.getByRole('button',{name:'配置嵌入连接',exact:true}).click();await page.getByRole('button',{name:'云端 embedding',exact:true}).click();
  await page.getByPlaceholder('模型名（如 text-embedding-3-small）').fill('synthetic-semantic-model');
  await page.getByPlaceholder('API Key',{exact:true}).fill('synthetic-only-key');
  await page.getByRole('button',{name:'保存嵌入连接（不启用旧记忆）',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[placeholder="模型名（如 text-embedding-3-small）"]')?.value==='synthetic-semantic-model');
  for(let i=0;i<100&&!writes.length;i++)await page.waitForTimeout(10);
  assert.equal(writes.length,1);assert.equal(writes[0].enabled,undefined);assert.equal(writes[0].stores,undefined);assert.equal(config.enabled,false);assert.equal(config.embedMode,'cloud');assert.equal(config.cloudEmbed.model,'synthetic-semantic-model');assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});}
});
