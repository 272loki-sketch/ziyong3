import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),{build}=require('../node_modules/esbuild/lib/main.js');
test('actual research SettingsPanel autosaves public consent on desktop/mobile',{timeout:40000},async()=>{
 const executable=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE;
 if(!executable)throw Error('Provide the test browser explicitly');
 const root=process.cwd(),cwd=await mkdtemp(join(tmpdir(),'liyuan-research-settings-'));
 let server,browser;const errors=[],puts=[];
 let config={card:'synthetic.json',userName:'SyntheticPrivatePlayer',webResearchMode:'off',webResearchPublicTerms:[],literaryWorldEnabled:false,literaryEcologyEnabled:false,generationMode:'direct',scanDepth:4,maxLoreInjections:3,compactEveryNTurns:30,stepModels:{},unrelatedSyntheticValue:'retained'};
 try{
  const contents=`import React from 'react';import{createRoot}from'react-dom/client';import{SettingsPanel}from'./src/components/SettingsPanel.tsx';createRoot(document.getElementById('root')).render(<SettingsPanel toast={()=>{}} generationMode="direct" onGenerationModeChange={()=>{}} onConfigGenerationMode={()=>{}} onOpenDatabase={()=>{}}/>);`;
  await build({stdin:{contents,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  await writeFile(join(cwd,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:8px;max-width:100%}input,select,textarea{max-width:100%;width:100%}.sp-section{border:1px solid #ddd;padding:8px}button{max-width:100%}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  server=createServer(async(req,res)=>{
   const route=req.url.split('?')[0];
   if(route==='/'||route==='/fixture.js'){res.setHeader('content-type',route==='/'?'text/html':'application/javascript');res.end(await readFile(join(cwd,route==='/'?'index.html':'fixture.js')));return;}
   res.setHeader('content-type','application/json');
   if(route==='/api/config'){
    if(req.method==='PUT'){let body='';for await(const part of req)body+=part;const patch=JSON.parse(body);puts.push(patch);config={...config,...patch};}
    res.end(JSON.stringify({config}));return;
   }
   if(route==='/api/models/catalog'){res.end(JSON.stringify({current:null,models:[]}));return;}
   if(route==='/api/memory'){res.end(JSON.stringify({config:{enabled:false,searchTopK:3,stores:[]},stores:[]}));return;}
   if(route==='/api/access/status'){res.end(JSON.stringify({required:false}));return;}
   if(route==='/api/database-plugin/status'){res.end(JSON.stringify({config:{enabled:false,recentHistoryMessages:8},sourceReady:false,ref:'synthetic',sha256:'',needsAuth:false}));return;}
   if(route==='/api/world-profile'){res.end(JSON.stringify({profile:null,card:{name:'Synthetic card',key:'synthetic.json'},materialsChanged:false}));return;}
   res.writeHead(404);res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:executable,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??''},args:process.getuid?.()===0?['--no-sandbox']:[]});
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const mode=page.locator('#web-research-mode'),terms=page.locator('#web-research-public-terms');await mode.waitFor();
  assert.equal(await mode.inputValue(),'off');assert.equal(await terms.inputValue(),'');
  await mode.selectOption('manual');await page.waitForTimeout(900);assert.equal(config.webResearchMode,'manual');
  await terms.fill('PublicSyntheticWork\nPublicCanonicalName');await page.waitForTimeout(900);assert.deepEqual(config.webResearchPublicTerms,['PublicSyntheticWork','PublicCanonicalName']);
  assert.equal(config.unrelatedSyntheticValue,'retained');assert.ok(puts.every(p=>!('apiKey'in p)&&!('providers'in p)));
  await page.reload({waitUntil:'domcontentloaded'});await terms.waitFor();assert.equal(await terms.inputValue(),'PublicSyntheticWork\nPublicCanonicalName');assert.equal(await mode.inputValue(),'manual');
  await page.setViewportSize({width:390,height:844});await mode.selectOption('auto');await page.waitForTimeout(900);assert.equal(config.webResearchMode,'auto');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
 }finally{
  await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});
 }
});
