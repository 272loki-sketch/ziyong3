import test from "node:test";import assert from "node:assert/strict";
import {createResearchEvidenceCache} from "../src/tools/research-cache.ts";
import {createResearchTurnScope} from "../src/tools/research-scope.ts";
test("ancestor-only cache reuses reference materials across turns, never sibling/session/version",async()=>{
	const cache=createResearchEvidenceCache();let queries=0,opens=0;
	const search=async(items:string[])=>{queries++;return items.map(query=>({query,results:[{title:"synthetic fact",url:"https://example.org/source",snippet:"discovery"}]}));};
	const open=async(url:string)=>{opens++;return{url,excerpt:"synthetic source"};};
	const scope=(contextKey:string,sourceLeafId:string,ids:string[])=>createResearchTurnScope("direct",search,open,undefined,()=>true,{cache,scope:{contextKey,sourceLeafId,ancestorIds:new Set(ids)}});
	const a=scope("session:card:revision","u1",["u1"]);await a.webResearch!(["fact"],3);await a.webOpen!("https://example.org/source","");
	const next=scope("session:card:revision","u2",["u1","a1","u2"]);assert.equal((await next.webResearch!(["fact"],3))[0].reused,true);await next.webOpen!("https://example.org/source","");assert.equal(queries,1);assert.equal(opens,1);
	const sibling=scope("session:card:revision","other",["root","other"]);await sibling.webResearch!(["fact"],3);assert.equal(queries,2);
	const revised=scope("session:card:new-revision","u3",["u1","u2","u3"]);await revised.webResearch!(["fact"],3);assert.equal(queries,3);
});
test("cache expires, bounds memory and never returns mutable shared receipts",()=>{
	let now=0;const cache=createResearchEvidenceCache(100,2,()=>now),scope={contextKey:"x",sourceLeafId:"a",ancestorIds:new Set(["a"])};
	cache.put("a",scope,{text:"first"});const receipt=cache.get<{text:string}>("a",scope)!;receipt.text="mutated";assert.equal(cache.get<{text:string}>("a",scope)?.text,"first");
	cache.put("b",scope,{});cache.put("c",scope,{});assert.equal(cache.get("a",scope),undefined);now=100;assert.equal(cache.get("b",scope),undefined);
});
test("ordinary turns never construct a cache context or spend any provider call",()=>{
	let contexts=0,requests=0;const scope=createResearchTurnScope("direct",async()=>{requests++;return[];},undefined,undefined,()=>true,{cache:createResearchEvidenceCache(),scope:()=>{contexts++;return{contextKey:"bound",sourceLeafId:"a",ancestorIds:new Set(["a"])};}});
	assert.ok(scope.webResearch);assert.equal(contexts,0);assert.equal(requests,0);
});
test("explicit refresh skips old evidence but cannot bypass actual request/read budgets",async()=>{
 const cache=createResearchEvidenceCache();let searches=0,reads=0;
 const search=async(queries:string[])=>{searches++;return queries.map(query=>({query,results:[{title:"public current fact",url:"https://primary.test/current",snippet:"discovery"}]}));};
 const open=async(url:string)=>{reads++;return{url,documentText:`Source version ${reads}`};};
 const make=(leaf:string,ancestors:string[])=>createResearchTurnScope("direct",search,open,undefined,()=>true,{cache,scope:{contextKey:"same",sourceLeafId:leaf,ancestorIds:new Set(ancestors)}});
 const first=make("a",["a"]);await first.webResearch!(["public current fact"],3);await first.webOpen!("https://primary.test/current","");
 const second=make("b",["a","b"]);assert.equal((await second.webResearch!(["public current fact"],3))[0].reused,true);assert.equal((await second.webOpen!("https://primary.test/current","")).reused,true);
 const fresh=await second.webResearch!(["public current fact"],3,undefined,true);assert.equal(searches,2);assert.equal(fresh[0].reused,false);assert.ok(fresh[0].retrievedAt);const page=await second.webOpen!("https://primary.test/current","",undefined,true);assert.equal(reads,2);assert.equal(page.reused,false);assert.ok(page.excerpt?.includes("version 2"));
 await second.webResearch!(["public current fact"],3,undefined,true);assert.ok((await second.webOpen!("https://primary.test/current","",undefined,true)).rejected);assert.equal(searches,3);assert.equal(reads,2);assert.ok((await second.webResearch!(["public current fact"],3,undefined,true))[0].rejected);
});
test("a failed explicit refresh does not silently reinstate a prior turn's stale receipt",async()=>{
 const cache=createResearchEvidenceCache();let fail=false;const search=async(queries:string[])=>{if(fail)throw Error("synthetic upstream outage");return queries.map(query=>({query,results:[{title:"old",url:"https://primary.test/current",snippet:"old"}]}));};
 const make=(leaf:string,ids:string[])=>createResearchTurnScope("direct",search,undefined,undefined,()=>true,{cache,scope:{contextKey:"same",sourceLeafId:leaf,ancestorIds:new Set(ids)}});
 await make("a",["a"]).webResearch!(["public current fact"],3);fail=true;const scope=make("b",["a","b"]);assert.ok((await scope.webResearch!(["public current fact"],3,undefined,true))[0].error);assert.ok((await scope.webResearch!(["public current fact"],3))[0].error);
});


test("host cached source bridge only returns authorized current-ancestor actual documents",async()=>{
 const cache=createResearchEvidenceCache(),url="https://primary.test/original";let opens=0;
 const search=async(queries:string[])=>queries.map(query=>({query,results:[{title:"primary",url,snippet:"discovery"}]}));
 const open=async(requested:string)=>{opens++;return{url:requested,documentText:"Actual source snapshot, not the author paraphrase."};};
 const make=(key:string,leaf:string,ids:string[],explicit:string[]=[])=>createResearchTurnScope("director",search,open,undefined,()=>true,{cache,scope:{contextKey:key,sourceLeafId:leaf,ancestorIds:new Set(ids)}},explicit);
 const first=make("session:version","a",["a"],[url]);await first.webOpen!(url,"");
 const next=make("session:version","b",["a","b"],[url]);const rows=next.cachedResearchSources();assert.equal(rows.length,1);assert.equal(rows[0].reused,true);assert.ok(rows[0].sourceFingerprint);assert.equal(opens,1);
 assert.deepEqual(make("session:version","b",["a","b"]).cachedResearchSources(),[]);
 assert.deepEqual(make("session:version","sibling",["sibling"],[url]).cachedResearchSources(),[]);
 assert.deepEqual(make("other:version","b",["a","b"],[url]).cachedResearchSources(),[]);
});
