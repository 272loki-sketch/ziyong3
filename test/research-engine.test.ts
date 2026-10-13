import test from "node:test";import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";import {join} from "node:path";
import {researchEngineFixture as fixture,researchDirectorScript as director,consultResearchExperts as consult} from "./support/research-engine-fixture.ts";
import {applyConfigPatch} from "../server/rest.ts";import {DEFAULT_CONFIG} from "../src/types.ts";
const call=(name:string,args:Record<string,unknown>={})=>({calls:[{name,args}]});
const sources=async(queries:string[])=>queries.map(query=>({query,results:[{title:query,url:"https://source.test/chapter",snippet:"Synthetic discovery, not verified canon"}]}));
const reply=(f:ReturnType<typeof fixture>)=>f.sm.getBranch().filter((entry:any)=>entry.message?.role==="assistant").at(-1) as any;

test("actual StageEngine: ordinary direct generates without invoking web or extra author steps",async()=>{
	let searches=0;const f=fixture("direct",[{text:"Synthetic ordinary emotional dialogue."}],{webResearch:async(...args)=>{searches++;return sources(args[0]);}});
	try{await f.engine.performTurn("Continue the ordinary synthetic conversation.");assert.equal(searches,0);assert.equal(f.requests.filter(x=>x.model==="writer").length,1);assert.equal(reply(f).message.details.rpAuthorDraft,"Synthetic ordinary emotional dialogue.");}finally{f.cleanup();}
});
test("actual StageEngine: off/manual/configured unsupported tool gates remain fail closed",async()=>{
	for(const [mode,input,supports] of [["off","联网核查公开资料",true],["manual","Continue ordinary synthetic scene",true],["auto","联网核查公开资料",false]] as const){
		let calls=0;const f=fixture("direct",[{text:"Synthetic ordinary output."}],{webResearchMode:mode,supportsTools:supports,webResearch:async()=>{calls++;return[];},webOpen:async url=>({url,excerpt:"not used"})});
		try{await f.engine.performTurn(input);const context=f.requests.find(x=>x.model==="writer")!.context;assert.equal((context.tools??[]).some((tool:any)=>tool.name==="web_research"),false);assert.equal(calls,0);}finally{f.cleanup();}
	}
});
test("actual direct chain searches, reads, then delivers same author's complete draft before settlement",async()=>{
	let searches=0,opens=0;const events:string[]=[];
	const f=fixture("direct",[call("web_research",{queries:["public technical fact"]}),call("web_open",{url:"https://source.test/chapter",focus:"chapter"}),{text:"Synthetic checked story <status>original format</status>"}],{webResearchMode:"manual",webResearch:async queries=>{searches++;return sources(queries);},webOpen:async url=>{opens++;return{url,excerpt:"Synthetic public technical fact, exact source excerpt."};},events:{onAuthorReady:()=>events.push("ready"),onTurnEnd:()=>events.push("end")},sideGate:async id=>{if(id==="scribe")assert.equal(events[0],"ready");}});
	try{await f.engine.performTurn("请联网核查这个公开技术细节");assert.equal(searches,1);assert.equal(opens,1);assert.equal(f.requests.filter(x=>x.model==="writer").length,3);assert.deepEqual(events,["ready","end"]);assert.match(JSON.stringify(f.requests.filter(x=>x.model==="writer").at(-1)!.context),/exact source excerpt/);assert.equal(reply(f).message.details.rpAuthorDraft,"Synthetic checked story <status>original format</status>");}finally{f.cleanup();}
});
test("actual director chain can chase conflicting sources without altering fixed 3/2/2 stages",async()=>{
	let searches=0,opens=0;
	const script=[call("web_research",{queries:["public historical date"]}),call("web_open",{url:"https://source.test/chapter",focus:"date"}),call("web_research",{queries:["public historical date site:archive.test"]}),call("web_open",{url:"https://source.test/chapter",focus:"original date"}),...director("Synthetic story preserving user world rules; conflicting external dates remain uncertain.")];
	const f=fixture("director",script,{webResearch:s=>{searches++;return sources(s);},webOpen:async url=>{opens++;return{url,excerpt:opens===1?"Untrusted second-hand date 1900":"Original synthetic archive gives 1901; first source conflicts"};},worldText:"In the synthetic world, two moons orbit the city."});
	try{await f.engine.performTurn("Research the public historical date but preserve my synthetic world.");assert.equal(searches,2);assert.equal(opens,2);assert.equal(f.requests.filter(x=>x.model==="literaryContinuity").length,1);assert.equal(f.requests.filter(x=>x.model==="directorSetting").length,1);assert.equal(f.requests.filter(x=>x.model==="directorIdeas").length,2);assert.equal(f.requests.filter(x=>x.model==="directorReviewFacts").length,1);assert.equal(f.requests.filter(x=>x.model==="directorReviewStyle").length,1);
		const report=f.requests.find(x=>x.model==="directorReviewFacts")!;assert.match(JSON.stringify(report.context),/external-untrusted/);assert.match(JSON.stringify(report.context),/Original synthetic archive/);assert.match(JSON.stringify(report.context),/two moons/);
		assert.equal(f.sm.getBranch().filter((e:any)=>e.customType==="rp-world-state").length,0);assert.match(reply(f).message.details.rpAuthorDraft,/conflicting external dates remain uncertain/);
	}finally{f.cleanup();}
});
test("provider failure and actual unsupported-tools fallback preserve basic writing",async()=>{
	const f=fixture("direct",[call("web_research",{queries:["public geography fact"]}),{text:"Synthetic story with openly uncertain external detail."}],{webResearch:async()=>{throw new Error("synthetic timeout");}});
	try{await f.engine.performTurn("Check a public geographic fact.");assert.match(reply(f).message.details.rpAuthorDraft,/uncertain/);}finally{f.cleanup();}
	const fallback=fixture("direct",[{error:"tools unsupported by this endpoint"},{text:"Synthetic tool-free story."}],{webResearch:sources});
	try{await fallback.engine.performTurn("Continue synthetic story.");assert.equal(reply(fallback).message.details.rpAuthorDraft,"Synthetic tool-free story.");}finally{fallback.cleanup();}
});
test("engine blocks private model-generated queries even with public franchise metadata",async()=>{
	let requests=0;const f=fixture("direct",[call("web_research",{queries:["SyntheticPrivateActor chapter"]}),{text:"Synthetic story without leaking identities."}],{webResearch:async()=>{requests++;return[];}});
	try{await f.engine.performTurn("Continue the synthetic scene.");assert.equal(requests,0);assert.match(JSON.stringify(f.requests.filter(x=>x.model==="writer")[1].context),/受保护身份/);}finally{f.cleanup();}
});
test("same active branch reuses completed references in later turns with no new network requests",async()=>{
	let searches=0,opens=0;const f=fixture("direct",[call("web_research",{queries:["public history fact"]}),call("web_open",{url:"https://source.test/chapter"}),{text:"First synthetic complete story."}],{webResearch:async q=>{searches++;return sources(q);},webOpen:async url=>{opens++;return{url,excerpt:"Synthetic archive evidence"};}});
	try{await f.engine.performTurn("Check a public history fact.");f.responses.push(call("web_research",{queries:["public history fact"]}),call("web_open",{url:"https://source.test/chapter"}),{text:"Second synthetic complete story."});await f.engine.performTurn("Use that public reference again.");assert.equal(searches,1);assert.equal(opens,1);}finally{f.cleanup();}
});
test("public terms settings are bounded, explicit, and preserve unrelated config",()=>{
	const next=applyConfigPatch({...DEFAULT_CONFIG,language:"Japanese",webResearchMode:"manual"},{webResearchPublicTerms:[" PublicCanonicalName ","PublicCanonicalName",123,"x".repeat(81)]});assert.deepEqual(next.webResearchPublicTerms,["PublicCanonicalName"]);assert.equal(next.language,"Japanese");assert.equal(next.webResearchMode,"manual");
});
test("cancel/reRoll and branch switch discard late external sources and preserve story authority",{timeout:10000},async()=>{
	let release!:(rows:any[])=>void, started!:()=>void;const began=new Promise<void>(r=>{started=r;});
	const f=fixture("direct",[call("web_research",{queries:["public delayed fact"]}),{text:"This late story must not be saved."}],{webResearch:async q=>{started();return new Promise(resolve=>{release=resolve;});}});
	try{
		const pending=f.engine.performTurn("Check a synthetic public delayed fact.");await began;f.engine.abort();release(await sources(["public delayed fact"]));await pending;
		assert.equal(f.sm.getBranch().filter((e:any)=>e.message?.role==="assistant").length,0);
		// The remaining scripted old reply is removed only in this synthetic provider.
		f.responses.splice(0);f.responses.push({text:"Fresh synthetic story after cancellation."});
		await f.engine.performTurn("Continue ordinary writing after cancellation.");assert.equal(reply(f).message.details.rpAuthorDraft,"Fresh synthetic story after cancellation.");
	}finally{f.cleanup();}
	let finish!:(rows:any[])=>void, entered!:()=>void;const begun=new Promise<void>(r=>{entered=r;});
	const branch=fixture("direct",[call("web_research",{queries:["public branching fact"]}),{text:"Stale branch story"}],{webResearch:async q=>{entered();return new Promise(r=>{finish=r;});}});
	try{const pending=branch.engine.performTurn("Check public branching fact.");await begun;const old=branch.sm.getLeafId();branch.sm.resetLeaf();finish(await sources(["public branching fact"]));await pending;assert.equal(branch.sm.getLeafId(),null);assert.equal(branch.sm.getBranch().filter((e:any)=>e.message?.role==="assistant").length,0);assert.ok(old);}finally{branch.cleanup();}
});
test("revoking web consent rejects late references without aborting basic writing",async()=>{
	let release!:(rows:any[])=>void,started!:()=>void;const entered=new Promise<void>(r=>{started=r;});
	const f=fixture("direct",[call("web_research",{queries:["public history fact"]}),call("web_open",{url:"https://source.test/chapter"}),{text:"Synthetic basic story after consent revocation."}],{webResearch:async()=>{started();return new Promise(r=>{release=r;});},webOpen:async()=>{throw Error("must not open revoked source");}});
	try{const pending=f.engine.performTurn("Check public history fact.");await entered;const config=JSON.parse(readFileSync(join(f.cwd,"liyuan.config.json"),"utf8"));writeFileSync(join(f.cwd,"liyuan.config.json"),JSON.stringify({...config,webResearchMode:"off"}));release(await sources(["public history fact"]));await pending;assert.equal(reply(f).message.details.rpAuthorDraft,"Synthetic basic story after consent revocation.");assert.match(JSON.stringify(f.requests.filter(x=>x.model==="writer").at(-1)!.context),/丢弃迟到/);}finally{f.cleanup();}
});
test("a local memory miss can still fall through to a public query without a false privacy match",async()=>{
	let searches=0;const f=fixture("direct",[call("memory_search",{query:"public historical lighthouse fact"}),call("web_research",{queries:["public historical lighthouse fact"]}),{text:"Synthetic basic story after legitimate public fallback."}],{webResearch:async q=>{searches++;return sources(q);}});
	try{await f.engine.performTurn("Check a public historical question.");assert.equal(searches,1);}finally{f.cleanup();}
});
test("explicit source URLs use the actual main-author reader without a redundant search",async()=>{
	let searches=0,opens=0;const f=fixture("direct",[call("web_open",{url:"https://official.test/reference"}),{text:"Synthetic answer based on the user-supplied public reference."}],{webResearchMode:"manual",webResearch:async()=>{searches++;return[];},webOpen:async url=>{opens++;return{url,documentText:"Synthetic official reference excerpt."};}});
	try{await f.engine.performTurn("请联网阅读 https://official.test/reference");assert.equal(searches,0);assert.equal(opens,1);assert.match(reply(f).message.details.rpAuthorDraft,/public reference/);}finally{f.cleanup();}
});
test("native main-author refresh of explicitly public identifiers reaches the real per-turn cache capability",async()=>{
 let searches=0,reads=0;const script=(refresh:boolean)=>[call("web_research",{queries:["public current fact"],refresh}),call("web_open",{url:"https://source.test/chapter",refresh}),{text:"Synthetic current-reference story."}];const f=fixture("direct",script(false),{publicTerms:["public current fact"],webResearch:async q=>{searches++;return sources(q);},webOpen:async url=>{reads++;return{url,documentText:`Synthetic source snapshot ${reads}`};}});
 try{await f.engine.performTurn("Check a public current fact.");f.responses.push(...script(true));await f.engine.performTurn("Refresh the public current fact.");assert.equal(searches,2);assert.equal(reads,2);const latest=JSON.stringify(f.requests.filter(x=>x.model==="writer").at(-1)!.context);assert.match(latest,/source snapshot 2/);assert.match(latest,/retrievedAt/);}finally{f.cleanup();}
});
