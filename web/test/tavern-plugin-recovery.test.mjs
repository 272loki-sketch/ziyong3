import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { build } from '../../web/node_modules/esbuild/lib/main.js';
import { chromium } from '../../node_modules/playwright/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function syntheticContext({ sessionId='synthetic-session', scopeKey='scope-a', sourceEntryId='entry-a', revision=4, counter=10 }={}) {
 const entry={__liyuanEntryId:sourceEntryId,mes:'Synthetic immutable story',is_user:false,is_system:false,extra:{},variables:{}};
 return {
  sessionId,scopeKey,sourceEntryId,visibleEntryIds:[sourceEntryId],revision,
  chat:[entry],userName:'Synthetic User',userPersona:'',model:{id:'synthetic-model',contextWindow:8192},
  character:{name:'Synthetic Character',avatar:'synthetic.png',description:'',personality:'',scenario:'',first_mes:'Synthetic immutable story',data:{extensions:{world:'synthetic-book'}}},
  preset:{name:'Synthetic Preset',prompts:[{identifier:'prompt-a',content:'synthetic'}],extensions:{presetValue:counter}},
  readonlyBooks:{},plugins:[],
  state:{chatMetadata:{variables:{counter}},extensionSettings:{variables:{global:{counter}},TavernHelper:{counter}},worldbooks:{},messages:{},characterExtensions:{},presetExtensions:{presetValue:counter}},
 };
}

test('bridge saves can be explicitly retried and rebinding preserves imported mutable references without crossing scopes', async () => {
 const previous={window:globalThis.window,document:globalThis.document,CustomEvent:globalThis.CustomEvent,SillyTavern:globalThis.SillyTavern,LiyuanTavern:globalThis.LiyuanTavern};
 globalThis.window={dispatchEvent(){}};
 globalThis.CustomEvent=class CustomEvent { constructor(type,init={}){this.type=type;this.detail=init.detail;} };
 globalThis.document={querySelector(){return null;}};
 try {
  // Use the real browser YAML entry: module namespace exports report writable:true
  // in descriptors, but their exotic [[Set]] still rejects assignments on rebind.
  const yamlNamespace=await import(pathToFileURL(join(root,'node_modules/yaml/browser/index.js')).href);
  assert.equal(Object.prototype.toString.call(yamlNamespace),'[object Module]');
  assert.equal(Object.isExtensible(yamlNamespace),false);
  globalThis.window.YAML=yamlNamespace;
  const {host}=await import(`${pathToFileURL(join(root,'web/public/tavern-compat/bridge.js')).href}?recovery-${Date.now()}`);
  await host.bind(syntheticContext());
  const oldLibModule=host.modules['/lib.js'];
  assert.strictEqual(host.resolve('/lib.js','yaml'),yamlNamespace);
  const oldScriptModule=host.modules['/script.js'];
  const oldExtensionModule=host.modules['/scripts/extensions.js'];
  const oldOpenAiModule=host.modules['/scripts/openai.js'];
  const oldGetCurrentChatId=host.resolve('/script.js','getCurrentChatId');
  const oldSaveChat=host.resolve('/script.js','saveChatConditional');
  const oldMetadata=host.resolve('/script.js','chat_metadata');
  const oldVariables=oldMetadata.variables;
  const oldExtensions=host.resolve('/scripts/extensions.js','extension_settings');
  const oldHelperSettings=oldExtensions.TavernHelper;
  const oldChat=host.resolve('/script.js','chat');
  const oldCharacters=host.resolve('/script.js','characters');
  const oldCard=oldCharacters[0];
  const oldPreset=host.resolve('/scripts/openai.js','oai_settings');
  const oldPresetExtensions=oldPreset.extensions;
  const writes=[];let failOnce=true;
  host.request=async(path,body,binding)=>{
   assert.equal(path,'/state');writes.push({body:structuredClone(body),binding:structuredClone(binding)});
   if(failOnce){failOnce=false;throw new Error('SYNTHETIC_507_STORAGE_FAILURE');}
   return {revision:body.revision+1};
  };
  await assert.rejects(host.save(),/SYNTHETIC_507_STORAGE_FAILURE/);
  assert.equal(writes.length,1,'a failed request is not automatically replayed');
  oldMetadata.variables.counter=11;
  await host.flush();
  assert.equal(writes.length,2,'an explicit flush retries the pending write once');
  assert.equal(writes[1].body.revision,4,'failed save does not invent a new revision');
  assert.equal(writes[1].body.state.chatMetadata.variables.counter,11);
  assert.equal(host.pending,false,'successful explicit flush clears pending state');

  await host.bind(syntheticContext({sessionId:'synthetic-session-b',scopeKey:'scope-b',sourceEntryId:'entry-b',revision:8,counter:99}));
  assert.strictEqual(host.modules['/script.js'],oldScriptModule);
  assert.strictEqual(host.modules['/scripts/extensions.js'],oldExtensionModule);
  assert.strictEqual(host.modules['/scripts/openai.js'],oldOpenAiModule);
  assert.strictEqual(host.modules['/lib.js'],oldLibModule);
  assert.strictEqual(host.resolve('/lib.js','yaml'),yamlNamespace,'rebinding preserves a real ESM namespace without writing its exports');
  assert.deepEqual(yamlNamespace.parse('synthetic: unchanged'),{synthetic:'unchanged'});
  assert.strictEqual(host.resolve('/script.js','chat_metadata'),oldMetadata);
  assert.equal(oldGetCurrentChatId(),'synthetic-session-b','an ESM-captured API callback resolves the currently bound session');
  assert.strictEqual(oldMetadata.variables,oldVariables);
  assert.equal(oldVariables.counter,99,'existing imported chat_metadata nested reference sees rebound data');
  assert.strictEqual(host.resolve('/scripts/extensions.js','extension_settings'),oldExtensions);
  assert.strictEqual(oldExtensions.TavernHelper,oldHelperSettings);
  assert.equal(oldHelperSettings.counter,99,'existing imported extension_settings reference sees latest variables');
  assert.strictEqual(host.resolve('/script.js','chat'),oldChat);
  assert.strictEqual(host.resolve('/script.js','characters'),oldCharacters);
  assert.strictEqual(oldCharacters[0],oldCard);
  assert.strictEqual(host.resolve('/scripts/openai.js','oai_settings'),oldPreset);
  assert.strictEqual(oldPreset.extensions,oldPresetExtensions);
  assert.equal(oldPreset.extensions.presetValue,99);
  oldHelperSettings.counter=100;
  await oldSaveChat();
  assert.equal(writes.at(-1).binding.scopeKey,'scope-b');
  assert.equal(writes.at(-1).body.state.extensionSettings.TavernHelper.counter,100,'the old captured save callback writes the latest object into its current binding');

  writes.length=0;
  const pendingOldScope=host.save();
  await host.bind(syntheticContext({scopeKey:'scope-c',sourceEntryId:'entry-c',revision:12,counter:123}));
  await assert.rejects(pendingOldScope,/会话或分支已变化/);
  await assert.rejects(host.flush(),/会话或分支已变化/);
  assert.equal(writes.length,0,'save and flush both refuse to retry work after rebinding to a different scope');

  const frozenBefore=Object.freeze({Alias:'before'}),frozenAfter=Object.freeze({Alias:'after'});
  globalThis.window.YAML=frozenBefore;await host.bind(syntheticContext());
  assert.strictEqual(host.resolve('/lib.js','yaml'),frozenBefore);
  globalThis.window.YAML=frozenAfter;await host.bind(syntheticContext());
  assert.strictEqual(host.resolve('/lib.js','yaml'),frozenAfter,'a mutable facade can safely replace a frozen library value');
  assert.equal(frozenBefore.Alias,'before','the previous immutable export is never modified');

  const readonlyBefore=Object.defineProperty({},'Alias',{value:'readonly-before',enumerable:true,writable:false,configurable:false});
  const readonlyAfter=Object.defineProperty({},'Alias',{value:'readonly-after',enumerable:true,writable:false,configurable:false});
  const frozenListBefore=Object.freeze([1]),frozenListAfter=Object.freeze([2]);
  const mutableLibrary={mutable:{counter:1},frozen:frozenBefore,readonly:readonlyBefore,list:frozenListBefore};
  globalThis.window.YAML=mutableLibrary;await host.bind(syntheticContext());
  const mutableReference=mutableLibrary.mutable;
  globalThis.window.YAML={mutable:{counter:2},frozen:frozenAfter,readonly:readonlyAfter,list:frozenListAfter};
  await host.bind(syntheticContext());
  assert.strictEqual(host.resolve('/lib.js','yaml'),mutableLibrary,'normal mutable library exports keep their original identity');
  assert.strictEqual(mutableLibrary.mutable,mutableReference);
  assert.equal(mutableReference.counter,2);
  assert.strictEqual(mutableLibrary.frozen,frozenAfter);
  assert.strictEqual(mutableLibrary.readonly,readonlyAfter);
  assert.strictEqual(mutableLibrary.list,frozenListAfter);
  assert.equal(readonlyBefore.Alias,'readonly-before');
  assert.deepEqual(frozenListBefore,[1]);
  assert.deepEqual(yamlNamespace.parse('synthetic: still-unchanged'),{synthetic:'still-unchanged'});
 } finally {
  for(const key of ['window','document','CustomEvent','SillyTavern','LiyuanTavern']){
   if(previous[key]===undefined)delete globalThis[key];else globalThis[key]=previous[key];
  }
 }
});

test('message frame retries transient status errors and clears failed state on entry, scope, HTML, retry, and plugin generation changes', { timeout: 40_000 }, async () => {
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-tavern-frame-recovery-'));
 let server,browser,page,statusRequests=0,unexpectedWrites=0,helperEnabled=true;
 const browserErrors=[],requestedPaths=[];
 const bridgeSource=await readFile(join(root,'web/public/tavern-compat/bridge.js'),'utf8');
 const hostSource=await readFile(join(root,'web/public/tavern-compat/host.js'),'utf8');
 const templateContext=syntheticContext({scopeKey:'scope-two',sourceEntryId:'entry-two'});
 // A read-only display fixture starts with a fully saved host state. Otherwise
 // host normalization itself legitimately queues a derived-state save at flush.
 templateContext.state={
  chatMetadata:templateContext.state.chatMetadata,
  extensionSettings:{...templateContext.state.extensionSettings,note:{allowWIScan:false},regex:[],disabledExtensions:[],quickReplyV2:{config:{setList:[]},chatConfig:{setList:[]}},EjsTemplate:{compile_workers:false}},
  characterExtensions:{world:'synthetic-book'},presetExtensions:templateContext.state.presetExtensions,
  messages:{'entry-two':{variables:{},extra:{}}},worldbooks:{},
 };
 const watchdog=setTimeout(()=>{server?.closeAllConnections?.();void browser?.close().catch(()=>{});},32_000);watchdog.unref();
 const stage=name=>process.stderr.write(`[tavern-recovery] ${name}\n`);
 try {
  const source=`import React,{useState} from '${join(root,'web/node_modules/react/index.js')}';import{createRoot}from'${join(root,'web/node_modules/react-dom/client.js')}';import{TavernMessageFrame,TavernEntryContext}from'${join(root,'web/src/components/TavernMessageFrame.tsx')}';function App(){const[entryId,setEntry]=useState('entry-one'),[entryScope,setScope]=useState('scope-one'),[html,setHtml]=useState('<div>first html</div>');window.__change=(key,value)=>({entryId:()=>setEntry(value),entryScope:()=>setScope(value),html:()=>setHtml(value)}[key]?.());window.__restart=()=>window.dispatchEvent(new CustomEvent('liyuan:tavern-plugins-changed'));function SafeOutput({html,scripts}){return <div id="legacy-fallback" data-entry={entryId} data-html={html} data-scripts={String(scripts)}>{html}</div>}return <TavernEntryContext.Provider value={{entryId,entryScope}}><TavernMessageFrame html={html}><SafeOutput html={html} scripts={true}/></TavernMessageFrame></TavernEntryContext.Provider>}createRoot(document.getElementById('root')).render(<App/>);`;
  await build({stdin:{contents:source,resolveDir:join(root,'web'),sourcefile:'synthetic-tavern-frame.tsx',loader:'tsx'},bundle:true,format:'esm',outfile:join(cwd,'fixture.js'),jsx:'automatic',logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const url=new URL(req.url??'/', 'http://127.0.0.1');requestedPaths.push(req.method+' '+url.pathname);
   if(url.pathname==='/api/tavern-plugins/status'&&req.method==='GET'){
    statusRequests++;const unavailable=statusRequests===1;res.writeHead(unavailable?503:200,{'content-type':'application/json'});res.end(JSON.stringify(unavailable?{error:'SYNTHETIC_TRANSIENT_STATUS_FAILURE'}:{runtimeEnabled:true,plugins:[{id:'helper',enabled:helperEnabled,installed:true,version:'synthetic'},{id:'template',enabled:true,installed:true,version:'synthetic'}]}));return;
   }
   if(req.method!=='GET')unexpectedWrites++;
   if(url.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(join(cwd,'fixture.js')));return;}
   if(url.pathname==='/tavern-plugin-host.html'){
    res.writeHead(200,{'content-type':'text/html'});
    if(helperEnabled){res.end(`<!doctype html><body><div id="synthetic-frame">host fixture</div><script>window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin)return;if(event.data?.type==='liyuan-tavern-render'){document.body.dataset.entry=event.data.entryId;document.getElementById('synthetic-frame').textContent=event.data.html;parent.postMessage({type:'liyuan-tavern-height',height:180},location.origin);}});addEventListener('load',()=>parent.postMessage({type:'liyuan-tavern-ready'},location.origin));</script></body>`);return;}
    res.end(`<!doctype html><html><body><div id="status"></div><div id="extensions_settings"></div><div id="extensions_settings2"></div><div id="chat"></div><div id="send_form"></div><script>window.EjsTemplate={prepareContext:async()=>({syntheticValue:'SAFE_EJS_VALUE'}),evalTemplate:async text=>String(text).replace('<%= syntheticValue %>','SAFE_EJS_VALUE')};</script><script type="module" src="/tavern-compat/host.js"></script></body></html>`);return;
   }
   if(url.pathname==='/tavern-compat/host.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(hostSource);return;}
   if (['/tavern-compat/i18n.js', '/tavern-compat/settings-ui.js', '/tavern-compat/mvu-adapter.js'].includes(url.pathname)) { res.writeHead(200, {'content-type':'text/javascript'}); res.end(await readFile(join(root, 'web/public', url.pathname), 'utf8')); return; }
   if(url.pathname==='/tavern-compat/bridge.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bridgeSource);return;}
   if(url.pathname==='/tavern-compat/vendor/yaml/index.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end('export default {};');return;}
   if(url.pathname==='/api/tavern-plugins/context'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(templateContext));return;}
   res.writeHead(200,{'content-type':'text/html'});res.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
  })().catch(error=>{res.writeHead(500);res.end(error.message);});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  const binary=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||join(root,'.liyuan-database-plugin/browser/headless_shell'),libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS||process.env.LD_LIBRARY_PATH||join(root,'.liyuan-database-plugin/browser-libs/lib64');
  stage('before-launch');
  browser=await chromium.launch({headless:true,timeout:10_000,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,LD_LIBRARY_PATH:libs},args:['--no-sandbox']});
  stage('launched');
  const pagePromise=browser.newPage({serviceWorkers:'block'});let pageTimer;
  page=await Promise.race([pagePromise,new Promise((_,reject)=>{pageTimer=setTimeout(()=>reject(new Error('browser.newPage exceeded 8s watchdog')),8_000);pageTimer.unref();})]).finally(()=>clearTimeout(pageTimer));page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(8000);stage('browser-ready');page.on('pageerror',error=>browserErrors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base);await page.locator('#legacy-fallback').waitFor();stage('app-mounted');
  await page.locator('iframe[title="原酒馆插件交互显示"]').waitFor({timeout:8000});
  assert.equal(statusRequests,2,'one transient failure is retried through a shared status request');stage('transient-status-retried');
  async function failCurrentFrame(){
   const iframe=page.locator('iframe[title="原酒馆插件交互显示"]');await iframe.waitFor();
   const element=await iframe.elementHandle();const frame=await element?.contentFrame();assert.ok(frame,'current render iframe is attached');await frame.evaluate(()=>parent.postMessage({type:'liyuan-tavern-error',error:'SYNTHETIC_RENDER_FAILURE'},location.origin));
   await page.getByRole('alert').waitFor();
  }
  async function recoverBy(change){await failCurrentFrame();await change();await page.locator('iframe[title="原酒馆插件交互显示"]').waitFor();assert.equal(await page.getByRole('alert').count(),0);}
  await failCurrentFrame();
  await page.getByRole('button',{name:'重试插件显示'}).click();stage('explicit-retry-clicked');
  await page.locator('iframe[title="原酒馆插件交互显示"]').waitFor();
  assert.equal(await page.getByRole('alert').count(),0,'explicit retry clears the failed state');stage('explicit-retry-recovered');
  assert.equal(statusRequests,3,'explicit retry revalidates status exactly once');
  await recoverBy(()=>page.evaluate(()=>window.__change('html','<div>second html</div>')));
  await recoverBy(()=>page.evaluate(()=>window.__change('entryScope','scope-two')));
  await recoverBy(()=>page.evaluate(()=>window.__change('entryId','entry-two')));stage('identity-recovery-complete');
  await recoverBy(()=>page.evaluate(()=>window.__restart()));
  assert.equal(statusRequests,4,'plugin generation change performs one fresh status read');
  helperEnabled=false;
  await page.evaluate(()=>window.__change('html','<div><%= syntheticValue %></div>'));
  await page.evaluate(()=>window.__restart());
  await page.waitForFunction(()=>document.querySelector('#legacy-fallback')?.getAttribute('data-html')==='<div>SAFE_EJS_VALUE</div>',{timeout:8000});
  assert.equal(await page.locator('#legacy-fallback').getAttribute('data-scripts'),'false','template-only output uses the existing parent HTML renderer with scripts disabled');
  assert.equal(await page.locator('iframe[title="原酒馆插件交互显示"]').count(),0,'template-only does not take over display with the helper render host');
  assert.equal(await page.locator('iframe[title="原酒馆模板求值隔离帧"]').count(),1,'template-only keeps only its hidden EJS evaluation realm');
  const templateFrame=page.frames().find(candidate=>candidate.url().includes('entryId=entry-two'));assert.ok(templateFrame,'template evaluation realm is loaded');
  assert.equal(await templateFrame.evaluate(()=>!!window.TavernHelper),false,'the template-only realm does not fake the disabled helper global');
  assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await page.locator('pre code').count(),0,'template-only never turns the HTML into a literal code block');
  assert.equal(statusRequests,5);stage('template-only-ejs-complete');
  assert.equal(unexpectedWrites,0,'status recovery and retry perform no writes or story mutation');
 } catch(error) {
  console.error('synthetic frame failure',JSON.stringify({browserErrors,requestedPaths,frames:await Promise.all((page?.frames()??[]).map(async frame=>({url:frame.url(),status:await frame.locator('#status').textContent({timeout:1000}).catch(()=>null)})))}));throw error;
 } finally {
  clearTimeout(watchdog);
  if(server?.listening)server.closeAllConnections?.();
  if(browser)await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,3000))]);
  if(server?.listening)await Promise.race([new Promise(resolve=>server.close(()=>resolve())),new Promise(resolve=>setTimeout(resolve,2000))]);
  await rm(cwd,{recursive:true,force:true});
 }
});
