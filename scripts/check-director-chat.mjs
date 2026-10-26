/** Real main.ts canary: separate HOME, card, config, session tree and localhost synthetic model. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readDiscussionStream} from '../web/src/planning/discussion-stream.ts';
import {stopCanaryChild} from './subprocess-cleanup.mjs';
const deadline=AbortSignal.timeout(60_000);
const request=(url,options={})=>fetch(url,{...options,signal:AbortSignal.any([deadline,AbortSignal.timeout(15_000)])});
const root=resolve(process.cwd());
const artifacts=process.argv.indexOf('--artifacts');
const work=artifacts>=0?resolve(process.argv[artifacts+1]):null;
if(work)await mkdir(work,{recursive:true});
const cwd=await mkdtemp(join(tmpdir(),'liyuan-discussion-main-'));let child,upstream,upstreamError,log='',calls=[];
try {
 for(const dir of ['home','agent','web','.liyuan'])await mkdir(join(cwd,dir));
 for(const dir of ['src','skills','node_modules'])await symlink(join(root,dir),join(cwd,dir),'dir');
 await symlink(join(root,'.liyuan/extensions'),join(cwd,'.liyuan/extensions'),'dir');
 await symlink(join(root,'web/public'),join(cwd,'web/public'),'dir');await symlink(join(root,'web/dist'),join(cwd,'web/dist'),'dir');
  upstream=createServer(async(req,res)=>{
   try {
  if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'fixture-director'}]}));return;}
  assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);calls.push(body);
  assert.equal(body.model,'fixture-director');assert.equal(body.stream,true,'Real discussion path must respect streaming');
  const packetText=typeof body.messages.at(-1).content==='string'?body.messages.at(-1).content:body.messages.at(-1).content.filter(x=>x.type==='text').map(x=>x.text).join('');assert.equal(JSON.parse(packetText).task,'outline-chat');
  const answer=JSON.stringify({answer:`Synthetic real-host discussion ${calls.length}`,options:[],proposal:null});
  res.writeHead(200,{'content-type':'text/event-stream'});
  const emit=(content,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:1,model:'fixture-director',choices:[{index:0,delta:content===null?{}:{content},finish_reason}]})+'\n\n');
   emit(answer.slice(0,24));await new Promise(r=>setTimeout(r,50));emit(answer.slice(24));emit(null,'stop');res.end('data: [DONE]\n\n');
   }catch(error){upstreamError=error;res.destroy();}
 });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const modelBase=`http://127.0.0.1:${upstream.address().port}/v1`;
 await writeFile(join(cwd,'package.json'),JSON.stringify({type:'module',version:'1.8.13'}));
 await writeFile(join(cwd,'card.json'),JSON.stringify({spec:'chara_card_v2',data:{name:'合成导演室角色',description:'仅合成验证，无生产素材',first_mes:'Synthetic opening',scenario:'Synthetic safe scene'}}));
 await writeFile(join(cwd,'liyuan.config.json'),JSON.stringify({card:'card.json',userName:'Fixture User',generationMode:'direct',compactEveryNTurns:999,literaryWorldEnabled:false,literaryEcologyEnabled:false,webResearchMode:'off',novelDigest:{enabled:false,autoSchedule:{enabled:false}},researchSearchSchedule:{enabled:false},stepModels:{outlineChat:{provider:'fixture',id:'fixture-director'}},fixtureUnknown:{retained:true}}));
 await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,providers:{fixture:{baseUrl:modelBase,api:'openai-completions',apiKey:'synthetic-not-a-real-key',models:[{id:'fixture-director',name:'Fixture',contextWindow:128000,maxTokens:16384,reasoning:false,compat:{streaming:true,supportsTools:true}}]}},defaultProvider:'fixture',defaultModel:'fixture-director',defaultThinkingLevel:'off'}));
 const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));const base=`http://127.0.0.1:${port}`;
   child=spawn(process.execPath,[join(root,'server/main.ts'),'--new'],{cwd,env:{...process.env,HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent'),PI_CODING_AGENT_DIR:join(cwd,'agent'),HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});child.on('error',error=>log+=error.stack);child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  let healthy=false;for(let i=0;i<100;i++){deadline.throwIfAborted();if(!child.pid||child.exitCode!==null||child.signalCode!==null)break;try{const r=await fetch(base+'/healthz',{signal:AbortSignal.any([deadline,AbortSignal.timeout(1_000)])});await r.body?.cancel();if(r.ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(healthy,'Synthetic host startup failed');
  const json=async path=>{const r=await request(base+path);assert.ok(r.ok);return r.json();};const initial=await json('/api/outline');assert.equal(initial.chats.length,0);assert.ok(initial.contextKey);
  const deltas=[];const result=await readDiscussionStream(await request(base+'/api/outline/chat/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'First synthetic host question',contextKey:initial.contextKey,focus:'open'})}),x=>deltas.push(x));assert.equal(result.reply,'Synthetic real-host discussion 1');assert.ok(deltas.length>=2);
 const after=await json('/api/outline');assert.equal(after.chats.length,1);assert.equal(after.chats[0].requestId,result.requestId);
  const second=await readDiscussionStream(await request(base+'/api/outline/chat/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'Continue from previous synthetic answer',contextKey:after.contextKey,focus:'open'})}));assert.equal(second.reply,'Synthetic real-host discussion 2');
 const lastContent=calls[1].messages.at(-1).content;const packet=JSON.parse(typeof lastContent==='string'?lastContent:lastContent.filter(x=>x.type==='text').map(x=>x.text).join(''));assert.equal(packet.context.discussionHistory.at(-1).text,result.reply);
  let r=await request(base+`/api/outline/chats/${encodeURIComponent(result.requestId)}?contextKey=${after.contextKey}`,{method:'DELETE'});assert.equal(r.status,200);assert.equal((await r.json()).chats.length,1);
  r=await request(base+`/api/outline/chats?contextKey=${after.contextKey}`,{method:'DELETE'});assert.equal(r.status,200);await r.body?.cancel();assert.equal((await json('/api/outline')).chats.length,0);
 const config=JSON.parse(await readFile(join(cwd,'liyuan.config.json'),'utf8'));assert.equal(config.fixtureUnknown.retained,true);assert.equal(config.generationMode,'direct');
 const report={mainStartup:true,realSDKStreaming:true,visibleDeltas:deltas.length,historyPersisted:true,continuationContext:true,singleRoundDelete:true,clearDiscussion:true,modelCalls:calls.length,paidOrProductionCalls:0};if(work)await writeFile(join(work,'main-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){if(work)await writeFile(join(work,'main-canary.log'),log);console.error(log.slice(-1600));throw upstreamError??error;}
finally{try{await stopCanaryChild(child);}finally{try{if(upstream){const closed=new Promise(r=>upstream.close(r));upstream.closeAllConnections();await closed;}}finally{await rm(cwd,{recursive:true,force:true});}}}
