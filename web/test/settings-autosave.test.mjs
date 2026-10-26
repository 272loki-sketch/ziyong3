// Synthetic settings only. Real config REST, no private credentials/story and no model calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {chromium} from 'playwright';
import {build} from '../node_modules/esbuild/lib/main.js';
import {configPath,handleApiRequest} from '../../server/rest.ts';
import {DEFAULT_CONFIG} from '../../src/types.ts';
const root=resolve(import.meta.dirname,'../..');
test('model plug selection persists when settings closes immediately, without changing other roles or connections', {timeout:45000}, async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-settings-autosave-'));let browser,server;const errors=[],writes=[];let failNext=false;
 try{
  const initial={...DEFAULT_CONFIG,card:'synthetic.json',stepModels:{literaryDirector:{provider:'fixture',id:'director'},writer:{provider:'fixture',id:'writer'}},unknownSetting:{keep:true}};
  await writeFile(configPath(cwd),JSON.stringify(initial));
  await writeFile(join(cwd,'synthetic.json'),JSON.stringify({name:'合成设置卡'}));
  const models={current:{provider:'fixture',id:'writer',name:'合成正文'},models:['writer','director','daily'].map(id=>({provider:'fixture',providerName:'合成渠道',id,name:'合成'+id,reasoning:false,vision:false,contextWindow:32000,maxTokens:4096}))};
  const host={cwd,isStreaming:()=>false,softRefreshConfig:async()=>{},notify:()=>{},listModels:()=>models};
  await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SettingsPanel}from'./src/components/SettingsPanel.tsx';const noop=()=>{};function App(){const[open,setOpen]=useState(true),[message,setMessage]=useState('');const toast=React.useCallback((_level,text)=>setMessage(text),[]);return <><p role="alert">{message}</p><button onClick={()=>setOpen(v=>!v)}>{open?'关闭设置':'打开设置'}</button>{open&&<SettingsPanel toast={toast} generationMode="direct" onGenerationModeChange={noop} onConfigGenerationMode={noop} onOpenDatabase={noop}/>}</>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/api/config'||url.pathname==='/api/models/catalog'){
    if(req.method==='PUT'){writes.push({url:req.url});if(failNext){failNext=false;res.writeHead(507,{'content-type':'application/json'});return res.end(JSON.stringify({error:'合成存储失败：岗位未保存'}));}}
    return handleApiRequest(req,res,host);
   }
   if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')))}
   if(url.pathname.startsWith('/api/')){res.writeHead(404,{'content-type':'application/json'});return res.end(JSON.stringify({error:'合成无关模块未启用'}))}
   res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  })().catch(error=>{errors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end()})});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  const binary=join(root,'.liyuan-database-plugin/browser/headless_shell'),libs=join(root,'.liyuan-database-plugin/browser-libs/lib64');
  browser=await chromium.launch({headless:true,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,...(existsSync(libs)?{LD_LIBRARY_PATH:libs}:{})},args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:950}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);const plug=page.locator('#model-plug-dailyPlot');await plug.waitFor();await page.waitForFunction(()=>!document.querySelector('#model-plug-dailyPlot').disabled);
  assert.equal(await plug.inputValue(),'');await plug.selectOption('fixture:daily');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.waitForTimeout(700);
  const saved=JSON.parse(await readFile(configPath(cwd),'utf8'));
  assert.deepEqual(saved.stepModels.dailyPlot,{provider:'fixture',id:'daily'},'closing before debounce must not silently discard the selected independent role');
  assert.deepEqual(saved.stepModels.literaryDirector,initial.stepModels.literaryDirector);assert.deepEqual(saved.unknownSetting,initial.unknownSetting);assert.equal(writes.length,1);
  await page.getByRole('button',{name:'打开设置',exact:true}).click();await plug.waitFor();await page.waitForFunction(()=>document.querySelector('#model-plug-dailyPlot')?.value==='fixture:daily');
  await page.setViewportSize({width:390,height:850});assert.equal(await plug.inputValue(),'fixture:daily');
  // Explicit removal is also immediate; do not resurrect it from an old full form snapshot.
  await plug.selectOption('');await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.waitForTimeout(600);
  assert.equal(JSON.parse(await readFile(configPath(cwd),'utf8')).stepModels.dailyPlot,undefined);
  await page.getByRole('button',{name:'打开设置',exact:true}).click();await plug.waitFor();await page.waitForFunction(()=>!document.querySelector('#model-plug-dailyPlot').disabled);
  assert.equal(await plug.inputValue(),'');
  // A rejected persistence operation must never turn into a success or a billed retry.
  failNext=true;await plug.selectOption('fixture:daily');await page.getByRole('alert').filter({hasText:'岗位未保存'}).waitFor();await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.waitForTimeout(600);
  assert.equal(JSON.parse(await readFile(configPath(cwd),'utf8')).stepModels.dailyPlot,undefined);assert.equal(writes.length,3);
  await page.getByRole('button',{name:'打开设置',exact:true}).click();await plug.waitFor();await page.waitForFunction(()=>!document.querySelector('#model-plug-dailyPlot').disabled);assert.equal(await plug.inputValue(),'');
  await plug.selectOption('fixture:daily');await page.getByRole('button',{name:'关闭设置',exact:true}).click();await page.waitForTimeout(600);
  const final=JSON.parse(await readFile(configPath(cwd),'utf8'));assert.deepEqual(final.stepModels.dailyPlot,{provider:'fixture',id:'daily'});assert.deepEqual(final.stepModels.literaryDirector,initial.stepModels.literaryDirector);assert.equal(writes.length,4);assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server)await new Promise(ok=>server.close(ok));await rm(cwd,{recursive:true,force:true});}
});
