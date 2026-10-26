import WebSocket from "ws";
import {SessionManager} from "@liyuan/agent-runtime";
/** Real main.ts + candidate build, isolated HOME/materials and no model credentials. */
import{mkdtemp,mkdir,writeFile,readFile,symlink,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{createServer}from'node:net';import{chromium}from'playwright';
import{TavernPluginSources}from'../server/tavern-plugin-source.ts';
import{stopCanaryChild}from'./subprocess-cleanup.mjs';
const root=process.cwd(),dist=resolve(process.argv[2]??'web/dist'),cwd=await mkdtemp(join(tmpdir(),'liyuan-plugin-main-canary-'));let child,browser,log='',stage='setup';const errors=[];
const checkpoint=value=>{stage=value;console.log('CANARY_STAGE',value);};
const controller=new AbortController();
const request=(url,options={})=>fetch(url,{...options,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])});
const deadline=setTimeout(()=>{console.error('CANARY_TIMEOUT',stage);errors.push(`Canary exceeded 60s at ${stage}`);controller.abort(new Error(`Canary exceeded 60s at ${stage}`));void browser?.close().catch(error=>errors.push(error.message));},60000);deadline.unref();
try{
 const socket=createServer();await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});const port=socket.address().port;await new Promise(r=>socket.close(r));
 await mkdir(join(cwd,'web'),{recursive:true});await mkdir(join(cwd,'home'),{recursive:true});await symlink(dist,join(cwd,'web/dist'));await symlink(join(root,'web/public'),join(cwd,'web/public'));
 await writeFile(join(cwd,'card.json'),JSON.stringify({name:'合成卡',description:'只用于宿主启动和界面验收，没有真实用户材料。',first_mes:'合成开场。\n<options>观察四周\n询问来意</options>'}));await writeFile(join(cwd,'liyuan.config.json'),JSON.stringify({card:'card.json',userName:'合成用户',greeting:true,generationMode:'direct',literaryEcologyEnabled:false,literaryWorldEnabled:false}));await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,providers:{}}));await writeFile(join(cwd,'package.json'),JSON.stringify({name:'liyuan-synthetic-canary',version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,type:'module'}));
 const sessionDir=join(cwd,'agent','sessions',`--${cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`);
 await mkdir(sessionDir,{recursive:true});const sm=SessionManager.create(cwd,sessionDir);
 sm.appendCustomEntry('rp-card',{card:'card.json',name:'合成卡'});
 const story='合成正文：主角留在屋内。',draft=story+'\n<options>观察四周\n询问来意</options>';
 sm.appendMessage({role:'assistant',content:[{type:'text',text:draft}],stopReason:'stop',details:{rpNarrative:story,rpAuthorDraft:draft,rpGenerationMode:'direct'},timestamp:Date.now()});sm.flush();
 const source=new TavernPluginSources(cwd);try{source.configure('helper',{autoUpdate:false,enabled:false});source.configure('template',{autoUpdate:false,enabled:false});}finally{source.close();}
  child=spawn(process.execPath,[join(root,'server/main.ts')],{cwd,env:{...process.env,HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent'),PI_CODING_AGENT_DIR:join(cwd,'agent'),HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});child.on('error',error=>log+=error.stack);child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 checkpoint('main-health');const base=`http://127.0.0.1:${port}`;let health;
  for(let i=0;i<100;i++){controller.signal.throwIfAborted();try{const r=await fetch(base+'/healthz',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(1000)])});if(r.ok){health=await r.json();break;}await r.body?.cancel();}catch{}if(!child.pid||child.exitCode!==null||child.signalCode!==null)throw Error('Isolated main exited: '+log.slice(-2000));await new Promise(r=>setTimeout(r,150));}
 if(!health?.ok)throw Error('Isolated main failed health: '+log.slice(-2000));
 if(health.sessionId!==sm.getSessionId())throw Error('Isolated main did not restore seeded synthetic session');
  checkpoint('websocket');const hello=await new Promise((resolve,reject)=>{
   const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);let settled=false;
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);ws.removeListener('message',onMessage);ws.removeListener('close',onClose);ws.terminate();if(error)reject(error);else resolve(value);};
   const onAbort=()=>finish(controller.signal.reason),onClose=()=>finish(Error('Canary WS closed before hello'));
   const onMessage=raw=>{try{const frame=JSON.parse(String(raw));if(frame.type==='hello')finish(null,frame);}catch(error){finish(error);}};
   const timer=setTimeout(()=>finish(Error('Canary WS timeout')),10000);
   ws.once('error',error=>finish(error));ws.once('close',onClose);ws.on('message',onMessage);controller.signal.addEventListener('abort',onAbort,{once:true});if(controller.signal.aborted)onAbort();
  });
 if(!hello.messages?.some(m=>m.authorDelivery?.includes('<options>')))throw Error('Synthetic author source missing from real hello');
  for(const path of ['/api/npc-parallel/status','/api/veridis-rewrite/status','/api/cardfront/regex']){const r=await request(base+path);if(!r.ok)throw Error(`Canary ${path} returned ${r.status}`);const data=await r.json();if(path.includes('rewrite/status')&&data.installed)throw Error('Canary unexpectedly reused production plugin cache');}
 checkpoint('browser-launch');browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE??join(root,'.liyuan-database-plugin/browser/headless_shell'),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??join(root,'.liyuan-database-plugin/browser-libs/lib64')},args:process.getuid?.()===0?['--no-sandbox']:[]});const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('liyuan.lastVisit',String(Date.now()));localStorage.removeItem('liyuan.atHome');});await page.route('**/*',route=>new URL(route.request().url()).host===new URL(base).host?route.continue():route.abort());checkpoint('app-navigation');await page.goto(base,{waitUntil:'domcontentloaded'});checkpoint('options-visible');
 try{await page.getByRole('button',{name:'选择行动：观察四周'}).waitFor({timeout:15000});}catch(error){console.log('SYNTHETIC CANARY DIAGNOSTIC',JSON.stringify({pageErrors:errors,stage,ui:await page.locator('body').innerText({timeout:1500}).then(s=>s.slice(0,2400)).catch(()=>'(page unavailable)'),server:log.slice(-1200)}));throw error;}if(await page.locator('.global-options-card').count()!==1)throw Error('Actual app did not render global greeting options');
 checkpoint('options-click');await page.getByRole('button',{name:'选择行动：观察四周'}).click();if(!await page.locator('textarea').evaluateAll(nodes=>nodes.some(n=>n.value==='观察四周')))throw Error('Actual action option did not fill main composer');
 checkpoint('manager-open');await page.getByRole('button',{name:/酒馆插件/}).first().click();checkpoint('manager-visible');await page.getByRole('article',{name:'Veridis Rewrite 来源与更新'}).waitFor();await page.getByRole('heading',{name:'众生侧写',exact:true}).waitFor();
 const result={healthVersion:health.version,realMain:true,candidateBuild:true,globalOptionsVisible:true,optionFillsComposer:true,newManagersVisible:true,originalMaterialsSynthetic:true,modelRequests:0,pageErrors:errors};if(process.env.PLUGIN_CANARY_AUDIT_OUTPUT)await writeFile(process.env.PLUGIN_CANARY_AUDIT_OUTPUT,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));if(errors.length)throw Error('Canary browser script errors');
}finally{clearTimeout(deadline);try{await browser?.close();}finally{try{await stopCanaryChild(child);}finally{await rm(cwd,{recursive:true,force:true});}}}
