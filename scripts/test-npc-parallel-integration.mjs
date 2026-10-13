/** Full isolated source -> raw plugin -> unified ecology canary. --live-model is explicitly chargeable. */
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';
import {NpcParallelHttp} from '../server/npc-parallel-http.ts';
import {computeNpcEcology} from '../src/stage/npc-ecology.ts';
import {defaultLiteraryEcologyState,normalizeLiteraryEcologyState,emptyEcologyGlobalPool,emptyEcologyCardPool} from '../src/stage/literary-ecology.ts';
import {defaultState} from '../src/state.ts';import{loadAgentConfig,resolveEnvApiKey}from'../src/agent-config.ts';
import{scanSkillFiles,workflowSkill}from'../src/stage/skill-store.ts';
const live=process.argv.includes('--live-model');const keep=process.argv.includes('--keep');const fixtureIdx=process.argv.indexOf('--fixture');
const cwd=mkdtempSync(join(tmpdir(),'liyuan-npc-integration-')),root=process.cwd();let http;
const narrative='上午九点到九点十分，主角一直在家中整理自己的账本，没有外出，也没有给任何人发消息。';
const branch=[{id:'synthetic-user',type:'message',message:{role:'user',content:'我在家继续核对账本。'}},{id:'synthetic-source',type:'message',message:{role:'assistant',details:{rpNarrative:narrative,rpAuthorDraft:narrative+'\n<options>继续核对账目</options>'}}}];
const original=JSON.stringify(branch);const scope={sessionId:'synthetic-session',card:'synthetic-card',sourceEntryId:'synthetic-source',visibleEntryIds:branch.map(e=>e.id)};
const ecology=normalizeLiteraryEcologyState({actors:[{id:'bookkeeper',name:'阿青',tier:'background',location:'书店',activity:'整理书架',shortGoal:'上午整理旧书',longGoal:'维持书店经营',knowledge:['店里今天要整理旧书'],nextAction:'把书放回架子'}]},defaultLiteraryEcologyState());
const state=defaultState();state.time='上午九点十分';state.location='家中';state.roster={characters:{主角:'在家整理账本',阿青:'在书店工作，未得知主角的私事'},items:{},events:{}};
const skills=scanSkillFiles(root),ecologySkill=workflowSkill(skills,'ecology-runtime'),npcSkill=workflowSkill(skills,'npc-ecology');
let requests=0;const usages=[];let liveModel,authKey;
if(live){const agent=loadAgentConfig(root).config,provider=agent.providers.new;liveModel={provider:'new',id:'gemini-3.8-flash',baseUrl:provider.baseUrl,headers:provider.headers??{}};if(!provider.models.some(m=>m.id===liveModel.id))throw Error('Dedicated model is unavailable');authKey=resolveEnvApiKey(provider.apiKey);if(!authKey)throw Error('Configured Flash auth is unavailable');}
const side=async(step,sp,ut,maxTokens,signal)=>{
 if(step!=='npcParallel')throw Error('Canary must not substitute an independent ecology author');
 if(++requests>6)throw Error('Live model canary request limit reached');
 if(!live){let data;try{data=JSON.parse(ut);}catch{}if(data?.npc_parallel){const c=data.npc_parallel.candidates[0];return JSON.stringify({actors:[{id:c.actorId,name:c.name,tier:'background',location:'书店',activity:'把书放回书架',nextAction:'继续整理旧书'}],npc_parallel_decisions:[{candidateId:c.id,actorId:c.actorId,verdict:'accept',reason:'合成场外生活与本拍一致',quote:c.text.slice(0,20),eventIds:[]}]});}return '<npc正文>上午九点，书店里，阿青把旧书放回书架，再到柜台核对店里的账目。</npc正文><npc信息>知道：店里的工作\n不知道：主角家中的事\n只能推断：无\n特殊感应：无</npc信息>';}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);try{
  const response=await fetch(String(liveModel.baseUrl).replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${authKey}`,...liveModel.headers},body:JSON.stringify({model:liveModel.id,messages:[...(sp?[{role:'system',content:sp}]:[]),{role:'user',content:ut}],temperature:0.3,max_tokens:maxTokens,stream:false}),signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
  const data=await response.json();usages.push({status:response.status,usage:data.usage??null,finishReason:data.choices?.[0]?.finish_reason});
  if(!response.ok)throw Error('Live Flash request failed, status '+response.status);if(data.choices?.[0]?.finish_reason==='length')throw Error('Truncated live Flash output');const text=data.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw Error('Empty live Flash output');return text;
 }finally{clearTimeout(timer);}
};
try{
 http=new NpcParallelHttp(cwd,{binding:()=>scope,isBusy:()=>false,config:()=>({ecologyEnabled:true,model:{provider:'new',id:'gemini-3.8-flash'}}),branch:()=>branch,ecology:()=>ecology,materials:()=>({card:{name:'主角'},config:{userName:'主角'},entries:[]})},root);
 const options={proxy:process.env.LIYUAN_NPC_PARALLEL_GIT_PROXY??process.env.LIYUAN_TAVERN_GIT_PROXY,...(fixtureIdx>=0?{fixtureRepo:process.argv[fixtureIdx+1]}:{})};
 await http.sources.install(options);http.sources.configure({enabled:true,autoUpdate:false});
 const saved=http.store.read(scope),s=structuredClone(saved.state);s.extensionSettings.npc_parallel={enabled:true,autoTrigger:true,pickBeforeGen:false,minGenTokens:0,minWords:150,maxWords:300,responseTokens:1500,maxPerRound:1,skipPresent:false,autoSyncDatabase:false,autoDetectPresence:false};http.store.save(scope,saved.revision,s,()=>{});
 const start=Date.now();const result=await computeNpcEcology({provider:http.provider(),scope,ecology,committedEcology:ecology,global:emptyEcologyGlobalPool(),cardPool:emptyEcologyCardPool('synthetic','card'),lore:[],state,history:[],userText:'我在家继续核对账本。',userEntryId:'synthetic-user',userName:'主角',charName:'主角',narrative,worldSignals:[],skillBody:ecologySkill.body,npcSkillBody:npcSkill.body,preTurn:true,previousRound:0,guard:()=>{if(JSON.stringify(branch)!==original)throw Error('Original branch was changed');},side});
 const evidence={live,installed:http.sources.status(),requests,usages,durationMs:Date.now()-start,originalUnchanged:JSON.stringify(branch)===original,degraded:result.degraded,receipt:result.npcReceipt?{status:result.npcReceipt.status,total:result.npcReceipt.entries.length,accepted:result.npcReceipt.entries.filter(e=>e.status==='accepted').length,rejected:result.npcReceipt.entries.filter(e=>e.status!=='accepted').length}:null,error:result.error??null};
 if(process.env.NPC_AUDIT_OUTPUT)writeFileSync(process.env.NPC_AUDIT_OUTPUT,JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
 if(result.degraded||!evidence.originalUnchanged||result.npcReceipt?.status!=='accepted')process.exitCode=1;
}finally{await http?.close();if(keep)console.log('Retained isolated fixture directory: '+cwd);else rmSync(cwd,{recursive:true,force:true});}
