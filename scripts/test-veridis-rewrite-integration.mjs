/** Isolated original Veridis source/core -> guarded display canary. --live-model incurs bounded model calls. */
import{mkdtempSync,rmSync,writeFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{VeridisRewriteHttp}from'../server/veridis-rewrite-http.ts';import{computeVeridisRewrite}from'../src/stage/veridis-rewrite.ts';import{loadAgentConfig,resolveEnvApiKey}from'../src/agent-config.ts';
const live=process.argv.includes('--live-model'),fixtureIdx=process.argv.indexOf('--fixture'),cwd=mkdtempSync(join(tmpdir(),'liyuan-veridis-integration-')),root=process.cwd();
const scope={sessionId:'synthetic-veridis-session',card:'synthetic-card',sourceEntryId:'synthetic-source',visibleEntryIds:['synthetic-source']};
const narrative='他翻到账本最后一页，眼底闪过一抹复杂的情绪。窗外的雨仍在下。',authorDraft=narrative+'\n<options>继续核对账目\n关上账本</options>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
let http,requests=0;const usages=[];let model,apiKey;if(live){const provider=loadAgentConfig(root).config.providers.new;if(!provider?.models?.some(m=>m.id==='gemini-3.8-flash'))throw Error('3.8 Flash not configured');model={baseUrl:provider.baseUrl,headers:provider.headers??{}};apiKey=resolveEnvApiKey(provider.apiKey);if(!apiKey)throw Error('Flash authentication unavailable');}
const generate=async(request,signal)=>{
 if(++requests>4)throw Error('Canary call cap reached');
 if(!live){const prompt=request.messages.map(m=>m.content).join('\n'),targets=[...prompt.matchAll(/<rewrite_target\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/rewrite_target>/g)];return JSON.stringify(Object.fromEntries(targets.map(m=>[m[1],m[2].replace('眼底闪过一抹复杂的情绪','停顿了一下')])));}
 const response=await fetch(String(model.baseUrl).replace(/\/+$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`,...model.headers},body:JSON.stringify({model:'gemini-3.8-flash',messages:request.messages,temperature:request.temperature??0.3,max_tokens:request.maxTokens,stream:false}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)});
 const data=await response.json();usages.push({status:response.status,usage:data.usage??null,finishReason:data.choices?.[0]?.finish_reason});if(!response.ok)throw Error('Flash request returned '+response.status);if(data.choices?.[0]?.finish_reason==='length')throw Error('Truncated rewrite response');const text=data.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw Error('Empty rewrite response');return text;
};
try{
 http=new VeridisRewriteHttp(cwd,{binding:()=>scope,isBusy:()=>false,model:()=>({provider:'new',id:'gemini-3.8-flash'}),branch:()=>[]},root);
 await http.sources.install({proxy:process.env.LIYUAN_VERIDIS_GIT_PROXY??process.env.LIYUAN_TAVERN_GIT_PROXY,...(fixtureIdx>=0?{fixtureRepo:process.argv[fixtureIdx+1]}:{})});http.sources.configure({enabled:true,autoUpdate:false});
 const before=authorDraft,start=Date.now();const provider=http.provider();const result=await computeVeridisRewrite(provider,{scope,authorDraft,narrative,guard:()=>{if(authorDraft!==before)throw Error('Original draft changed');},generate:async(request,signal)=>{provider.claimRequest(scope,()=>{});return generate(request,signal);}});
 const evidence={live,source:http.sources.status(),requests,usages,durationMs:Date.now()-start,originalUnchanged:before===authorDraft,status:result.status,changed:result.changed,error:result.error??null,formatPreserved:!!result.text?.includes('<options>继续核对账目\n关上账本</options>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>')};
 if(process.env.VERIDIS_AUDIT_OUTPUT)writeFileSync(process.env.VERIDIS_AUDIT_OUTPUT,JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));if(result.status!=='complete'||!result.changed||!evidence.originalUnchanged||!evidence.formatPreserved)process.exitCode=1;
}finally{await http?.close();rmSync(cwd,{recursive:true,force:true});}
