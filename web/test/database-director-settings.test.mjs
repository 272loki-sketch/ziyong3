// Synthetic real settings/REST integration; no production data, credentials or model generation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {build} from '../node_modules/esbuild/lib/main.js';
import {configPath,handleApiRequest} from '../../server/rest.ts';
import {DatabasePluginHttp} from '../../server/database-plugin-http.ts';
import {DEFAULT_CONFIG} from '../../src/types.ts';
const root=resolve(import.meta.dirname,'../..');
test('settings selector is the shared recall/plot/director owner; desktop/mobile edits sync actual DB config and native presets, not fill',{timeout:60000},async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-director-settings-'));let browser,server,modelCalls=0;const errors=[],writes=[];
 const flash={provider:'secondary',id:'gemini-3.8-flash'},argon={provider:'primary',id:'gemini-4-argon'};
 try{
  const initial={...DEFAULT_CONFIG,generationMode:'direct',card:'synthetic.json',stepModels:{literaryDirector:flash,scribe:flash},unknownSetting:{keep:true}};
  await writeFile(configPath(cwd),JSON.stringify(initial));await writeFile(join(cwd,'synthetic.json'),JSON.stringify({name:'合成设置卡'}));
  const channel=model=>({baseUrl:'https://synthetic-model.invalid/v1',api:'openai-completions',apiKey:'SYNTHETIC_LOCAL_ONLY',models:[{id:model}]});
  await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'primary',defaultModel:argon.id,providers:{primary:channel(argon.id),secondary:channel(flash.id)}}));
  const db=new DatabasePluginHttp(cwd,{context:()=>({scope:{sessionId:'synthetic'},sourceEntryId:'synthetic',visibleEntryIds:[],chat:[],character:{name:'合成卡'},userName:'合成用户'}),generate:async()=>{modelCalls++;throw Error('No model calls allowed');},isStreaming:()=>false});
  const dbFile=join(cwd,'.liyuan-database-plugin/config.json');await writeFile(dbFile,JSON.stringify({version:1,enabled:false,fillModel:flash,recallModel:flash,unknownDatabase:{keep:true}}));
  const catalog={current:{...argon,name:argon.id},models:[flash,argon].map(ref=>({...ref,providerName:ref.provider,name:ref.id,reasoning:false,vision:false,contextWindow:128000,maxTokens:8192}))};
  const host={cwd,isStreaming:()=>false,softRefreshConfig:async()=>{db.syncDirectorModel();},notify:()=>{},listModels:()=>catalog};
  await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SettingsPanel}from'./src/components/SettingsPanel.tsx';function App(){const[open,setOpen]=useState(true);const toast=React.useCallback(()=>{},[]);return <><button onClick={()=>setOpen(v=>!v)}>{open?'关闭设置':'打开设置'}</button>{open&&<SettingsPanel toast={toast} generationMode="direct" onGenerationModeChange={()=>{}} onConfigGenerationMode={()=>{}} onOpenDatabase={()=>{}}/>}</>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const path=new URL(req.url,'http://localhost').pathname;
   if(path==='/api/config'||path==='/api/models/catalog'){if(req.method==='PUT')writes.push(path);return handleApiRequest(req,res,host);}
   if(path.startsWith('/api/database-plugin/'))return db.handle(req,res);
   if(path==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')));}
   if(path.startsWith('/api/')){res.writeHead(404,{'content-type':'application/json'});return res.end(JSON.stringify({error:'无关合成模块未启用'}));}
   res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  })().catch(error=>{errors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end();});});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  const binary=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE??join(root,'.liyuan-database-plugin/browser/headless_shell'),libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS??join(root,'.liyuan-database-plugin/browser-libs/lib64');
  browser=await chromium.launch({headless:true,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,...(existsSync(libs)?{LD_LIBRARY_PATH:libs}:{})},args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:950}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  for(const [width,model]of [[1280,argon],[390,flash]]){
   await page.setViewportSize({width,height:950});const selector=page.getByLabel('记忆召回 / 剧情推进 / 文学导演',{exact:true});await selector.waitFor();await page.waitForFunction(()=>!document.querySelector('#model-plug-literaryDirector')?.disabled);
   await selector.selectOption(model.provider+':'+model.id);await page.getByRole('button',{name:'关闭设置',exact:true}).click();
   for(let n=0;;n++){const current=JSON.parse(await readFile(dbFile,'utf8'));if(current.recallModel.provider===model.provider&&current.recallModel.id===model.id)break;if(n>60)throw Error('DB model did not sync from actual settings PUT');await page.waitForTimeout(100);}
   const saved=JSON.parse(await readFile(configPath(cwd),'utf8')),stored=JSON.parse(await readFile(dbFile,'utf8'));assert.deepEqual(saved.stepModels.literaryDirector,model);assert.deepEqual(saved.stepModels.scribe,flash);assert.deepEqual(saved.unknownSetting,{keep:true});assert.deepEqual(stored.fillModel,flash);assert.deepEqual(stored.unknownDatabase,{keep:true});
   const native=await(await fetch(base+'/api/database-plugin/context')).json();assert.equal(native.managedModels.recallModelSource,'literaryDirector');assert.equal(native.managedModels.presets.find(p=>p.purpose==='recall').model,model.id);assert.equal(native.managedModels.presets.find(p=>p.purpose==='fill').model,flash.id);assert.ok(!JSON.stringify(native).includes('SYNTHETIC_LOCAL_ONLY'));
   await page.getByRole('button',{name:'打开设置',exact:true}).click();
  }
  assert.equal(writes.length,2);assert.equal(modelCalls,0);assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server)await new Promise(ok=>server.close(ok));await rm(cwd,{recursive:true,force:true});}
});
