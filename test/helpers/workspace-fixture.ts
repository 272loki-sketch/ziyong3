/** Entirely synthetic parent + real isolated workers. Denies non-loopback traffic. */
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setPassword,ACCESS_COOKIE} from '../../src/access.ts';
const root=resolve(import.meta.dirname,'../..');
export async function until(check:()=>boolean|Promise<boolean>,timeout=20_000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,30));}throw Error('synthetic workspace fixture timeout');}
export async function workspaceFixture(dist?:string, cards?: Record<string, unknown>, worldbooks?: Record<string, unknown>){
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-main-workspace-'));
 let modelCalls=0,writerCalls=0,held=false,release=()=>{};
 const requests: Array<{model:string;messages:unknown[]}> = [];
 let child:ChildProcess|undefined;
 const model=createServer((req,res)=>{void(async()=>{
  let raw='';for await(const bytes of req)raw+=bytes;
  const data=JSON.parse(raw);modelCalls++;requests.push({model:data.model,messages:data.messages});
  let content:string;
  if(data.model==='writer'){writerCalls++;if(held)await new Promise<void>(ok=>{release=ok;});content=`合成正文第${writerCalls}楼：独立故事沿着原有记忆继续。`;}
  else if(data.model==='director')content=JSON.stringify({scenePressure:'合成场景',characterInitiatives:[{character:'合成人物',motive:'继续',immediateIntent:'观察',limit:'已有事实'}],candidateBeats:['继续']});
  else content=JSON.stringify({patch:{location:'合成场景'}});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:`synthetic-${modelCalls}`,object:'chat.completion',created:1,model:data.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:8,total_tokens:18}}));
 })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
 await new Promise<void>(ok=>model.listen(0,'127.0.0.1',ok));
 const modelBase=`http://127.0.0.1:${(model.address() as {port:number}).port}`;
 mkdirSync(join(cwd,'.liyuan'));mkdirSync(join(cwd,'cards'));mkdirSync(join(cwd,'web/dist'),{recursive:true});
 for(const name of ['src','skills','node_modules'])symlinkSync(join(root,name),join(cwd,name),process.platform==='win32'?'junction':'dir');
 symlinkSync(join(root,'.liyuan/extensions'),join(cwd,'.liyuan/extensions'),process.platform==='win32'?'junction':'dir');
 symlinkSync(join(root,'web/public'),join(cwd,'web/public'),process.platform==='win32'?'junction':'dir');
 writeFileSync(join(cwd,'web/dist/index.html'),'<!doctype html><html><head></head><body>synthetic UI</body></html>');
 writeFileSync(join(cwd,'package.json'),JSON.stringify({name:'synthetic-workspace-host',version:'1.8.16',type:'module'}));
 if(worldbooks){mkdirSync(join(cwd,'assets/lorebooks'),{recursive:true});for(const [name,book]of Object.entries(worldbooks))writeFileSync(join(cwd,'assets/lorebooks',name+'.json'),JSON.stringify(book));}
 for(const name of ['Primary','Independent'])writeFileSync(join(cwd,`cards/${name}.json`),JSON.stringify(cards?.[name]??{data:{name:`合成${name}`,description:`合成人物${name}`,first_mes:`${name}独立合成开场`}}));
 writeFileSync(join(cwd,'liyuan.config.json'),JSON.stringify({card:'cards/Primary.json',userName:'PrimaryUser',greeting:true,generationMode:'direct',literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false},stepModels:{literaryDirector:{provider:'fixture',id:'director'},scribe:{provider:'fixture',id:'scribe'}}}));
 writeFileSync(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'fixture',defaultModel:'writer',defaultThinkingLevel:'off',providers:{fixture:{baseUrl:modelBase+'/v1',api:'openai-completions',apiKey:'synthetic-not-real',compat:{streaming:false,supportsTools:true,supportsDeveloperRole:false},models:[{id:'writer'},{id:'director'},{id:'scribe'}]}}}));
 const guard=join(cwd,'network-guard.mjs');writeFileSync(guard,`const f=globalThis.fetch;globalThis.fetch=(input,...args)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('synthetic fixture denies external fetch'));return f(input,...args)};`);
 const auth=setPassword(cwd,'synthetic-workspace-password'),cookie=`${ACCESS_COOKIE}=${auth.token}`;
 let port=0,log='';
 const stop=async()=>{if(!child)return;const proc=child;child=undefined;if(proc.exitCode===null&&proc.signalCode===null){const exited=new Promise<void>(ok=>proc.once('exit',()=>ok()));proc.kill();await exited;}};
 const start=async()=>{
  const probe=createServer();await new Promise<void>(ok=>probe.listen(0,'127.0.0.1',ok));port=(probe.address() as {port:number}).port;await new Promise<void>(ok=>probe.close(()=>ok()));
  child=spawn(process.execPath,[join(root,'server/main.ts')],{cwd,env:{...process.env,NODE_OPTIONS:`--import=${JSON.stringify(pathToFileURL(guard).href)}`,HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent'),PI_CODING_AGENT_DIR:join(cwd,'agent'),HOST:'127.0.0.1',PORT:String(port),LIYUAN_PLAY_SLOT_CHILD:'0',LIYUAN_WEB_DIST_DIR:dist??join(cwd,'web/dist')},stdio:['ignore','pipe','pipe']});
  child.stdout!.on('data',bytes=>{log=(log+bytes.toString()).slice(-12_000);});child.stderr!.on('data',bytes=>{log=(log+bytes.toString()).slice(-12_000);});
  await until(async()=>{if(child!.exitCode!==null)throw Error('synthetic server exited: '+log);try{
   const base=`http://127.0.0.1:${port}`,html=await(await fetch(base+'/',{headers:{cookie}})).text();
   const workspace=html.match(/name="liyuan-workspace" content="([^"]*)"/)?.[1],lease=html.match(/name="liyuan-workspace-lease" content="([^"]*)"/)?.[1];
   if(!workspace||!lease)return false;
   return(await fetch(base+'/healthz',{headers:{cookie,'x-liyuan-workspace':workspace,'x-liyuan-workspace-lease':lease}})).ok;
  }catch{return false;}});
 };
 try{await start();}catch(error){await stop();await new Promise<void>(ok=>model.close(()=>ok()));rmSync(cwd,{recursive:true,force:true});throw error;}
 return{cwd,cookie,requests,get base(){return`http://127.0.0.1:${port}`;},get log(){return log;},get calls(){return modelCalls;},get writers(){return writerCalls;},hold(){held=true;},release(){held=false;release();},stop,start,async close(){held=false;release();await stop();await new Promise<void>(ok=>{model.closeAllConnections();model.close(()=>ok());});rmSync(cwd,{recursive:true,force:true});}};
}
