import { streamSimple } from "@liyuan/ai/compat";
import { abortable, abortableEvents } from "../src/async-abort.ts";
import { analysisRequestTimeoutMs, createRequestDeadline, requestAbortError } from "../src/request-budget.ts";
import { requestFailure, type RequestFailure } from "../src/stage/request-failure.ts";
import { modelResponseFailure } from "../src/stage/model-failure.ts";
import type { DatabaseRequestObservation } from "../src/stage/performance.ts";
import { databasePluginChatReply, type DatabasePluginGenerationOptions, type DatabasePluginChatReply, type DatabasePluginModelRef } from "./database-plugin-models.ts";
export interface DatabasePluginGenerationDependencies {
 findModel(ref:DatabasePluginModelRef):any;
 defaultModel():any;
 /** Unified settings role wins over cached native recall model references, never over fill. */
 recallModel?():DatabasePluginModelRef|undefined;
 /** Read on every call; managed fill/recall use the same configured analysis budget. */
 analysisTimeoutMinutes?():number|undefined;
 /** Safe host activity only; never injected into model context. */
  onActivity?(detail:string):void;
  observation?():DatabaseRequestObservation|undefined;
  failureObserver?():((failure:RequestFailure)=>void)|undefined;
 auth(model:any):Promise<{ok:boolean;apiKey?:string;headers?:Record<string,string>}>;
 stream?: (model: Parameters<typeof streamSimple>[0], context: Parameters<typeof streamSimple>[1], options: Omit<NonNullable<Parameters<typeof streamSimple>[2]>, "reasoning"> & { reasoning?: NonNullable<Parameters<typeof streamSimple>[2]>["reasoning"] | "off" }) => ReturnType<typeof streamSimple>;
}
export function createDatabasePluginGenerator(dependencies:DatabasePluginGenerationDependencies){
 return async function runDatabasePluginModel(prompts:Array<{role:string;content:string}>,signal?:AbortSignal,options:DatabasePluginGenerationOptions={}):Promise<DatabasePluginChatReply>{
	signal?.throwIfAborted();
	let observation:DatabaseRequestObservation|undefined;
	try { observation=dependencies.observation?.(); } catch { /* Observation cannot prevent a request. */ }
	let failureObserver:((failure:RequestFailure)=>void)|undefined;
	try { failureObserver=dependencies.failureObserver?.(); } catch { /* Observation cannot prevent a request. */ }
	const ref=options.purpose==="recall"?(dependencies.recallModel?.()??options.modelRef):options.modelRef;
	const model=ref?dependencies.findModel(ref):dependencies.defaultModel();
	if(!model)throw new Error("数据库模型未配置或已不在梨园启用清单");
	const timeoutMs=analysisRequestTimeoutMs({analysisTimeoutMinutes:dependencies.analysisTimeoutMinutes?.()});
	const deadline=createRequestDeadline(signal,timeoutMs,"analysis","数据库模型请求");
	const label=options.purpose==="recall"?"原数据库召回":"原数据库填表";
	const started=Date.now();let credential:string|undefined;
	let attempt:ReturnType<DatabaseRequestObservation["collector"]["beginCall"]>|undefined;
	const activity=(detail:string)=>{try{dependencies.onActivity?.(detail);}catch{/* Observation cannot change a paid request's outcome. */}};
	try {
	const auth=await abortable(dependencies.auth(model),deadline.signal);
	deadline.signal.throwIfAborted();
	if(!auth.ok)throw new Error("数据库模型鉴权不可用");
	credential=auth.apiKey;
	const payload=options.payload??{};
	const systemPrompt=prompts.filter(p=>p.role==="system").map(p=>p.content).join("\n\n");
	const messages=prompts.filter(p=>p.role!=="system").map((p:any)=>{
		if(p.role==="tool")return {role:"toolResult",toolCallId:p.tool_call_id,toolName:p.name||"table_edit",content:[{type:"text",text:p.content||""}],isError:false,timestamp:0};
		if(p.role==="assistant")return {role:"assistant",content:[...(p.content?[{type:"text",text:p.content}]:[]),...(Array.isArray(p.tool_calls)?p.tool_calls.map((t:any)=>({type:"toolCall",id:t.id,name:t.function?.name,arguments:JSON.parse(t.function?.arguments||"{}")})):[])],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:0};
		return {role:"user",content:[{type:"text",text:p.content||""}],timestamp:0};
	});
	const memoryHeaders={...(auth.headers??{})};if(!memoryHeaders["user-agent"]&&!memoryHeaders["User-Agent"])memoryHeaders["user-agent"]="Mozilla/5.0";
	const tools=Array.isArray(payload.tools)?payload.tools.map((t:any)=>({name:t.function.name,description:t.function.description||"",parameters:t.function.parameters})):undefined;
	if(tools?.length&&(model.compat as {supportsTools?:boolean}|undefined)?.supportsTools===false)throw new Error("所选数据库模型已声明不支持工具调用，请关闭原插件填表工具模式");
	options.validateBinding?.();
	const send = dependencies.stream ?? ((m, c, o) => streamSimple(m, c, { ...o, reasoning: o.reasoning === "off" ? undefined : o.reasoning }));
	deadline.signal.throwIfAborted();
	activity(`${label}：请求 ${model.provider}/${model.id}（单次分析时限 ${Math.round(timeoutMs/60000)} 分钟）`);
	// Count SDK dispatches only, using the owner captured before asynchronous authentication.
	try { attempt=observation?.collector.beginCall(observation.phase); } catch { /* Observation cannot prevent dispatch. */ }
	const source=send(model as never,{systemPrompt,messages:messages as never,...(tools?.length?{tools:tools as never}:{})},{apiKey:auth.apiKey,headers:memoryHeaders,maxTokens:Math.min(model.maxTokens??16384,Math.max(256,Number(payload.max_tokens)||16384)),...(typeof payload.temperature==="number"?{temperature:payload.temperature}:{}),reasoning:"off",signal:deadline.signal,timeoutMs,maxRetries:0});
	let terminal:Awaited<ReturnType<typeof source.result>>|undefined,streamFailed=false;
	for await(const event of abortableEvents(source,deadline.signal)){
	 if(event.type==="done"){terminal=event.message;break;}
	 if(event.type==="error"){terminal=event.error;streamFailed=true;break;}
	}
	if(deadline.signal.aborted)throw requestAbortError(deadline.signal);
	const result=terminal??await abortable(source.result(),deadline.signal);
	attempt?.usage(result.usage);
	if(deadline.signal.aborted)throw requestAbortError(deadline.signal);
	options.validateBinding?.();
	const responseFailure=modelResponseFailure(result)??(streamFailed?"Provider stream error":undefined);
	if(responseFailure){
	 const failure=requestFailure(responseFailure,deadline.signal,credential);
	 throw new Error("数据库模型没有完成，本次记忆没有成功收据："+failure.reason,{cause:new Error(failure.reason)});
	}
	const text=result.content.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("");
	const reply=databasePluginChatReply(text,model.id);
	const calls=result.content.filter(part=>part.type==="toolCall").map(part=>part.type==="toolCall"?{id:part.id,type:"function",function:{name:part.name,arguments:JSON.stringify(part.arguments)}}:null).filter(Boolean);
	if(calls.length){reply.choices[0].message.tool_calls=calls;reply.choices[0].finish_reason="tool_calls";}
	const usage=result.usage;
	if(usage){
	 const actual=Object.fromEntries([["prompt_tokens",usage.input],["completion_tokens",usage.output],["total_tokens",usage.totalTokens]].filter(([,value])=>typeof value==="number"&&Number.isFinite(value)&&value>=0));
	 if(Object.values(actual).some(value=>Number(value)>0))reply.usage=actual as Record<string,number>;
	}
	attempt?.end("success");
	activity(`${label}：请求完成（${Math.round((Date.now()-started)/1000)} 秒）`);return reply;
	}catch(error){
	 const failure=requestFailure(error,deadline.signal,credential);
	 try { failureObserver?.(failure); } catch { /* Failure observation cannot change the request outcome. */ }
	 attempt?.end(failure.origin==="cancelled"?"aborted":"failed");
	 const origin=failure.origin==="local-timeout"?"本地预算到期":failure.origin==="cancelled"?"已取消":failure.origin==="provider"?`上游${failure.statusCode?" HTTP "+failure.statusCode:"拒绝"}`:"SDK/传输错误";
	 activity(`${label}：请求失败（${origin}）；${failure.reason}`);
	 if(deadline.signal.aborted)throw requestAbortError(deadline.signal);
	 throw error;
	}finally{deadline.dispose();}
}

}
