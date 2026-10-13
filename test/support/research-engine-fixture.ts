import {mkdtempSync,writeFileSync,mkdirSync,cpSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";
import {SessionManager} from "@liyuan/agent-runtime";
import {StageEngine,type StageEngineDeps,type StageStreamFn,type StageEvents} from "../../src/stage/engine.ts";
import {DIRECTOR_ROLES} from "../../src/stage/agent-director.ts";
export interface ResearchResponse { text?:string; calls?:Array<{name:string;args?:Record<string,unknown>}>; error?:string }
export const consultResearchExperts=(phase:keyof typeof DIRECTOR_ROLES):ResearchResponse=>({calls:[{name:"consult_experts",args:{tasks:DIRECTOR_ROLES[phase].map(role=>({role,task:"Synthetic bounded report"}))}}]});
export const researchDirectorScript=(body:string):ResearchResponse[]=>[consultResearchExperts("evidence"),consultResearchExperts("ideas"),{calls:[{name:"begin_narrative"}]},{text:body},consultResearchExperts("review"),{calls:[{name:"finalize"}]}];
export function researchEngineFixture(mode:"direct"|"director",responses:ResearchResponse[],options:{webResearchMode?:"off"|"manual"|"auto";supportsTools?:boolean;webResearch?:StageEngineDeps["webResearch"];webOpen?:StageEngineDeps["webOpen"];events?:StageEvents;rawCard?:unknown;publicTerms?:string[];worldText?:string;sideGate?:(id:string,context:any)=>Promise<void>;cwd?:string;Engine?:typeof StageEngine;nextResponse?:(context:any)=>ResearchResponse}={}) {
	const cwd=options.cwd??mkdtempSync(join(tmpdir(),"liyuan-research-engine-"));
	const rawCard=options.rawCard??{data:{name:"SyntheticPrivateActor",description:"Synthetic private character",first_mes:"Synthetic greeting",...(options.worldText?{character_book:{entries:[{id:1,comment:"Synthetic world rule",content:options.worldText,constant:true,enabled:true,keys:[]}]}}:{})}};
	writeFileSync(join(cwd,"card.json"),JSON.stringify(rawCard));mkdirSync(join(cwd,".liyuan"),{recursive:true});cpSync(new URL("../../skills/",import.meta.url),join(cwd,"skills"),{recursive:true});
	const steps=["literaryDirector","literaryContinuity","directorSetting","ecologyRuntime","directorIdeas","directorReviewFacts","directorReviewStyle","plotAdaptation","scribe"];
	writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",userName:"SyntheticPrivatePlayer",generationMode:mode,literaryQuality:"guided",literaryWorldEnabled:false,literaryEcologyEnabled:false,webResearchMode:options.webResearchMode??"auto",webResearchPublicTerms:options.publicTerms??[],stepModels:Object.fromEntries(steps.map(id=>[id,{provider:"faux",id}]))}));
	const sm=SessionManager.create(cwd,join(cwd,"sessions"));const requests:Array<{model:string;context:any}>=[];
	const model={id:"writer",provider:"faux",maxTokens:10000,compat:{supportsTools:options.supportsTools??true}};
	const streamFn:StageStreamFn=(m,context)=>{
		requests.push({model:m.id,context:structuredClone(context)});
		let response:ResearchResponse;
		if(m.id==="writer"){response=responses.shift()??options.nextResponse?.(context)!;if(!response)throw new Error("Unexpected synthetic writer request");}
		else if(m.id==="literaryDirector")response={text:JSON.stringify({scenePressure:"Synthetic existing task",characterInitiatives:[],candidateBeats:["Continue existing scene"]})};
		else if(m.id==="scribe")response={text:JSON.stringify({patch:{location:"Synthetic room"}})};
		else response={text:JSON.stringify({summary:"Synthetic report",facts:[],inferences:[],candidates:[],issues:[]})};
		const message:any={role:"assistant",content:response.calls?response.calls.map((call,i)=>({type:"toolCall",id:`synthetic-${requests.length}-${i}`,name:call.name,arguments:call.args??{}})):[{type:"text",text:response.text??""}],stopReason:response.error?"error":response.calls?"toolUse":"stop",...(response.error?{errorMessage:response.error}:{})};
		return{async *[Symbol.asyncIterator](){await options.sideGate?.(m.id,context);if(response.text)yield{type:"text_delta",delta:response.text};yield response.error?{type:"error",error:message}:{type:"done",message};},async result(){return message;}} as never;
	};
	const engine=new (options.Engine??StageEngine)({cwd,getSessionManager:()=>sm as never,getModel:()=>model,findModel:(provider,id)=>({...model,provider,id}),getAuth:async()=>({}),streamFn,events:options.events,webResearch:options.webResearch,webOpen:options.webOpen});
	return{cwd,sm,requests,engine,responses,cleanup:()=>{engine.abort();rmSync(cwd,{recursive:true,force:true});}};
}
