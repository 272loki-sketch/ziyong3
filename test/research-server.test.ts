/** Real main.ts, WS, AI SDK HTTP transport and search host; synthetic localhost API only. */
import test from "node:test";import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";import {join} from "node:path";import {spawn} from "node:child_process";
import {createServer} from "node:http";import {once} from "node:events";import net from "node:net";import WebSocket from "ws";
import {DIRECTOR_ROLES} from "../src/stage/agent-director.ts";
const flow=(name:string,args:Record<string,unknown>={})=>({tool_calls:[{id:"synthetic-call",type:"function",function:{name,arguments:JSON.stringify(args)}}]});

test("isolated real backend uses configured SDK tool protocol in direct and director, with no private config",{timeout:45000},async()=>{
	const root=process.cwd(),cwd=mkdtempSync(join(tmpdir(),"liyuan-research-server-"));
	let child:ReturnType<typeof spawn>|undefined,ws:WebSocket|undefined,log="",searchCalls=0,writerCalls=0;const payloads:any[]=[];
	const script:any[]=[];
	const api=createServer(async(req,res)=>{
		let body="";for await(const chunk of req)body+=chunk;let data:any;try{data=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}
		if(req.url==="/search"){searchCalls++;res.setHeader("content-type","application/json");res.end(JSON.stringify({results:[{title:"public history date",url:"https://example.org/",snippet:"Synthetic public history date source candidate"},{title:"public history date rejected target",url:"https://127.0.0.1/internal",snippet:"public history date synthetic negative candidate"}]}));return;}
		assert.equal(req.url,"/v1/chat/completions");payloads.push(data);
		let message:any;
		if(data.model==="synthetic-writer"){writerCalls++;message=script.shift();if(!message)throw new Error("Unexpected SDK writer request");}
		else if(data.model==="literaryDirector")message={content:JSON.stringify({scenePressure:"Synthetic existing scene",characterInitiatives:[],candidateBeats:["Continue current scene"]})};
		else if(data.model==="scribe")message={content:JSON.stringify({patch:{location:"Synthetic room"}})};
		else message={content:JSON.stringify({summary:"Synthetic independent report",facts:[],inferences:[],candidates:[],issues:[]})};
		const finish=message.tool_calls?"tool_calls":"stop";
		if(data.stream){res.setHeader("content-type","text/event-stream");const delta=message.tool_calls?{role:"assistant",tool_calls:message.tool_calls.map((call:any,i:number)=>({...call,index:i}))}:{role:"assistant",content:message.content};res.write('data: '+JSON.stringify({id:"synthetic",object:"chat.completion.chunk",model:data.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:"synthetic",object:"chat.completion.chunk",model:data.model,choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');}
		else{res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"synthetic",object:"chat.completion",model:data.model,choices:[{index:0,message:{role:"assistant",...message},finish_reason:finish}]}));}
	});api.listen(0,"127.0.0.1");await once(api,"listening");const apiAddress=api.address();if(!apiAddress||typeof apiAddress==="string")throw new Error("no port");
	try{
		for(const dir of ["home","agent","tmp","web",".liyuan"])mkdirSync(join(cwd,dir));
		for(const name of ["src","skills","node_modules"])symlinkSync(join(root,name),join(cwd,name),"dir");
		symlinkSync(join(root,".liyuan/extensions"),join(cwd,".liyuan/extensions"),"dir");symlinkSync(join(root,"web/public"),join(cwd,"web/public"),"dir");symlinkSync(join(root,"web/dist"),join(cwd,"web/dist"),"dir");
		writeFileSync(join(cwd,"package.json"),JSON.stringify({type:"module",version:"1.8.16"}));
		writeFileSync(join(cwd,"card.json"),JSON.stringify({data:{name:"SyntheticPrivateActor",description:"Synthetic backend card",first_mes:"",extensions:{}}}));
		const steps=["literaryDirector","literaryContinuity","directorSetting","ecologyRuntime","directorIdeas","directorReviewFacts","directorReviewStyle","scribe"];
		writeFileSync(join(cwd,"liyuan.config.json"),JSON.stringify({card:"card.json",userName:"SyntheticPrivatePlayer",greeting:false,generationMode:"direct",literaryQuality:"guided",webResearchMode:"auto",literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false},stepModels:Object.fromEntries(steps.map(id=>[id,{provider:"synthetic",id}]))}));
		writeFileSync(join(cwd,"liyuan.agent.json"),JSON.stringify({version:1,defaultProvider:"synthetic",defaultModel:"synthetic-writer",providers:{synthetic:{baseUrl:`http://127.0.0.1:${apiAddress.port}/v1`,api:"openai-completions",apiKey:"SYNTHETIC-NOT-A-REAL-CREDENTIAL",models:["synthetic-writer",...steps].map(id=>({id,name:id,reasoning:false,input:["text"],contextWindow:128000,maxTokens:8192,compat:{supportsTools:true}}))}}}));
		const listener=net.createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");const a=listener.address();if(!a||typeof a==="string")throw new Error("port");await new Promise<void>(r=>listener.close(()=>r()));const base=`http://127.0.0.1:${a.port}`;
		// Keep platform essentials, not ambient model credentials, proxies, agent paths or Node hooks.
		const env:NodeJS.ProcessEnv={};for(const key of ["PATH","SystemRoot","WINDIR","LD_LIBRARY_PATH"])if(process.env[key]!==undefined)env[key]=process.env[key];
		Object.assign(env,{HOME:join(cwd,"home"),USERPROFILE:join(cwd,"home"),TMPDIR:join(cwd,"tmp"),TMP:join(cwd,"tmp"),TEMP:join(cwd,"tmp"),LIYUAN_CODING_AGENT_DIR:join(cwd,"agent"),PI_CODING_AGENT_DIR:join(cwd,"agent"),PI_OFFLINE:"1",HOST:"127.0.0.1",PORT:String(a.port),LIYUAN_WEB_RESEARCH_URL:`http://127.0.0.1:${apiAddress.port}/search`,LIYUAN_WEB_RESEARCH_PROXY:"direct"});
		let spawnError:Error|undefined;const started=Date.now();
		child=spawn(process.execPath,[join(root,"server/main.ts")],{cwd,env,stdio:["ignore","pipe","pipe"]});child.on("error",error=>spawnError=error);child.stdout!.on("data",data=>log+=data);child.stderr!.on("data",data=>log+=data);
		let ready=false,lastProbe="not attempted";const deadline=started+9000;
		for(;Date.now()<deadline;){
			if(spawnError||child.exitCode!==null||child.signalCode!==null)break;
			try{const response=await fetch(base+"/healthz",{signal:AbortSignal.timeout(Math.min(500,deadline-Date.now()))});lastProbe=`HTTP ${response.status}`;await response.body?.cancel();if(response.ok){ready=true;break;}}catch(error){lastProbe=error instanceof Error?`${error.name}: ${error.message}`:String(error);}
			await new Promise(r=>setTimeout(r,75));
		}
		assert.ok(ready,`Isolated backend readiness failed after ${Date.now()-started}ms (Node ${process.version}, exit=${child.exitCode}, signal=${child.signalCode}, spawn=${spawnError?.message??"none"}, health=${lastProbe}); startup log: ${log.slice(-2000)||"<empty>"}`);
		const frames:any[]=[];
        ws=new WebSocket(`ws://127.0.0.1:${a.port}/ws`,{headers:{origin:base}});ws.on("message",data=>frames.push(JSON.parse(data.toString())));await once(ws,"open");
        for(let i=0;i<50&&!frames.some(frame=>frame.type==="hello");i++)await new Promise(r=>setTimeout(r,20));
        const sessionId=frames.find(frame=>frame.type==="hello")?.sessionId;assert.ok(sessionId);
		async function turn(mode:"direct"|"director"){
			const before=frames.length;
			ws!.send(JSON.stringify({type:"prompt",text:"Check a public history date using public sources.",generationMode:mode,sessionId,messageId:`synthetic-${mode}-${Date.now()}`}));
			for(let i=0;i<200;i++){if(frames.slice(before).some(frame=>frame.type==="agent"&&frame.state==="end"))return;await new Promise(r=>setTimeout(r,75));}
			throw new Error("Synthetic SDK turn timeout: "+log.slice(-800)+JSON.stringify(frames.slice(-4)));
		}
		script.push(flow("web_research",{queries:["public history date"]}),flow("web_open",{url:"https://127.0.0.1/internal"}),{content:"Direct synthetic verified-transport story."});await turn("direct");
		assert.equal(searchCalls,1);assert.equal(writerCalls,3);assert.match(JSON.stringify(payloads.filter(p=>p.model==="synthetic-writer").at(-1)?.messages),/无法安全读取/);assert.ok(frames.some(frame=>frame.type==="agent"&&frame.state==="settling"));
		for(const phase of ["evidence","ideas"] as const)script.push(flow("consult_experts",{tasks:DIRECTOR_ROLES[phase].map(role=>({role,task:"Synthetic bounded expert report"}))}));
		script.push(flow("begin_narrative"),{content:"Director synthetic single-author story."},flow("consult_experts",{tasks:DIRECTOR_ROLES.review.map(role=>({role,task:"Synthetic read-only review"}))}),flow("finalize"));await turn("director");
		assert.equal(writerCalls,9,"both modes must finish their actual fixed workflows");assert.equal(script.length,0);assert.ok(payloads.filter(p=>p.model==="synthetic-writer")[0].tools.some((tool:any)=>tool.function.name==="web_research"));assert.ok(payloads.some(p=>p.model==="directorReviewFacts"));assert.equal(searchCalls,1,"director with sufficient local data must not search by harness fiat");
		assert.doesNotMatch(JSON.stringify(payloads.find(p=>p.model==="synthetic-writer").messages),/SYNTHETIC-NOT-A-REAL-CREDENTIAL/);
	}finally{
		ws?.terminate();if(child?.pid&&child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");await once(child,"exit");}
		api.closeAllConnections();await new Promise<void>(r=>api.close(()=>r()));rmSync(cwd,{recursive:true,force:true});
	}
});
