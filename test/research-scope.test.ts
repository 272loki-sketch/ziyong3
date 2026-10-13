import assert from "node:assert/strict";
import { test } from "node:test";
import { createResearchTurnScope } from "../src/tools/research-scope.ts";

const search = async (queries: string[]) => queries.map(query=>({
	query,results:[{title:query,url:"https://example.org/"+encodeURIComponent(query),snippet:query}],
}));

test("direct only searches three queries and opens one approved source",async()=>{
	let opens=0;
	const scope=createResearchTurnScope("direct",search,async url=>{opens++;return {url,excerpt:"已找到正文"};});
	const queries=await scope.webResearch!(["a","b","c"],3);
	assert.equal(queries.length,3);
	assert.equal((await scope.webResearch!(["d"],3))[0].rejected,"本拍联网查询额度已用完");
	const url=queries[0].results![0].url;
	assert.equal((await scope.webOpen!("https://other.invalid/private","x")).rejected !== undefined,true);
	assert.equal((await scope.webOpen!(url,"x")).excerpt,"已找到正文");
	assert.equal((await scope.webOpen!(url,"x")).excerpt,"已找到正文");
	assert.equal(opens,1);
	assert.ok((await scope.webOpen!(queries[1].results![0].url,"x")).rejected);
});

test("director can follow up to nine queries and six distinct reads",async()=>{
	let queries=0, opens=0;
	const scope=createResearchTurnScope("director",async(items,max)=>{queries+=items.length;return search(items);},
		async url=>{opens++;return {url,excerpt:"正文"};});
	let urls:string[]=[];
	for(let i=0;i<3;i++){const batch=await scope.webResearch!([String(i*3),String(i*3+1),String(i*3+2)],3);
		urls.push(...batch.flatMap(x=>x.results?.map(y=>y.url)??[]));}
	assert.equal(queries,9);
	assert.equal((await scope.webResearch!(["10"],3))[0].rejected,"本拍联网查询额度已用完");
	for(let i=0;i<6;i++)assert.ok((await scope.webOpen!(urls[i],"some detail")).excerpt);
	assert.equal(opens,6);
	assert.ok((await scope.webOpen!(urls[6],"")).rejected);
});

test("abort discards late source and forbids future opens",async()=>{
	const controller=new AbortController();
	let finish!: (value:{query:string;results:{title:string;url:string;snippet:string}[]}[])=>void;
	const scope=createResearchTurnScope("director",()=>new Promise<{query:string;results:{title:string;url:string;snippet:string}[]}[]>(resolve=>{finish=resolve;}),async url=>({url,excerpt:"no"}),controller.signal);
	const waiting=scope.webResearch!(["a"],3);
	controller.abort();
	finish([{query:"a",results:[{title:"title",url:"https://example.org/x",snippet:""}]}]);
	assert.ok((await waiting)[0].rejected);
	assert.ok((await scope.webOpen!("https://example.org/x","")).rejected);
});

test("repeated lookup reuses the same source without spending another query", async () => {
	let calls = 0;
	const scope = createResearchTurnScope("direct", async (queries) => {
		calls++;
		return queries.map(query => ({ query, results: [{ title: "hit", url: "https://example.org/" + query, snippet: query }] }));
	});
	await scope.webResearch!(["a", "b"], 3);
	const repeated = await scope.webResearch!(["a", "c"], 3);
	assert.deepEqual(repeated.map(x => x.query), ["a", "c"]);
	assert.equal(calls, 2);
	assert.ok((await scope.webResearch!(["d"], 3))[0].rejected);
	assert.equal((await scope.webResearch!(["a"], 3))[0].query, "a");
	assert.equal(calls, 2);
});

test("parallel identical lookup joins an in-flight provider request", async () => {
	let calls = 0;
	let release!: (result: {query:string;results:{title:string;url:string;snippet:string}[]}[])=>void;
	const scope = createResearchTurnScope("director", async () => {
		calls++;
		return new Promise(resolve => { release = resolve; });
	});
	const first = scope.webResearch!(["parallel"],3);
	const second = scope.webResearch!(["parallel"],3);
	await Promise.resolve();
	release([{query:"parallel",results:[{title:"correct",url:"https://example.org/a",snippet:"fact"}]}]);
	assert.equal((await first)[0].results?.[0]?.title,"correct");
	assert.equal((await second)[0].results?.[0]?.title,"correct");
	assert.equal(calls,1);
});

test("maxResults reuse is complete, sliced per caller and associated by query, not batch order", async () => {
	let requests = 0;
	const scope = createResearchTurnScope("direct", async (queries, cap) => {
		requests++; assert.equal(cap, 5);
		return queries.toReversed().map(query => ({ query, results: Array.from({length:5}, (_,i) => ({title:query,url:`https://example.org/${query}/${i}`,snippet:"fact"})) }));
	});
	assert.equal((await scope.webResearch!(["alpha", "beta"], 1))[0].results?.[0].title, "alpha");
	assert.equal((await scope.webResearch!(["alpha"], 5))[0].results?.length, 5);
	assert.equal(requests, 1);
});
test("failed requests can retry once, cannot loop, and other questions remain usable", async () => {
	let requests=0;
	const scope=createResearchTurnScope("direct",async queries=>{requests++;if(requests<3)throw new Error("failure");return search(queries);});
	assert.ok((await scope.webResearch!(["alpha"],3))[0].error);
	assert.ok((await scope.webResearch!(["alpha"],3))[0].error);
	assert.ok((await scope.webResearch!(["alpha"],3))[0].rejected);
	assert.ok((await scope.webResearch!(["beta"],3))[0].results?.length);
	assert.equal(requests,3);
});
test("a non-cooperative provider does not block cancellation or authorize late URLs", async () => {
	const controller=new AbortController();
	const scope=createResearchTurnScope("direct",async()=>new Promise(()=>{}),async url=>({url,excerpt:"bad"}),controller.signal);
	const waiting=scope.webResearch!(["alpha"],3); controller.abort();
	assert.ok((await waiting)[0].rejected);
});
test("scope invalidation rejects both cached search and cached page receipts", async () => {
	let current=true;
	const scope=createResearchTurnScope("direct",search,async url=>({url,excerpt:"good"}),undefined,()=>current);
	const rows=await scope.webResearch!(["alpha"],3); const url=rows[0].results![0].url;
	await scope.webOpen!(url,""); current=false;
	assert.ok((await scope.webOpen!(url,"")).rejected);
	assert.ok((await scope.webResearch!(["alpha"],3))[0].rejected);
});
test("child deadline reaches providers and discards late material", async () => {
	const controller=new AbortController(); let providerSignal:AbortSignal|undefined;
	const scope=createResearchTurnScope("direct",async(_,cap,signal)=>{providerSignal=signal;return new Promise(()=>{});});
	const waiting=scope.webResearch!(["alpha"],3,controller.signal);controller.abort();
	assert.ok((await waiting)[0].rejected);assert.equal(providerSignal?.aborted,true);
});
test("different focuses and parallel readers share one bounded document; raw body is not returned",async()=>{
	let reads=0;const scope=createResearchTurnScope("direct",search,async url=>{reads++;return{url,documentText:"alpha ".repeat(1000)+"precise omega event"};});
	const results=await scope.webResearch!(["topic"],3);const url=results[0].results![0].url;
	const [a,b]=await Promise.all([scope.webOpen!(url,"alpha"),scope.webOpen!(url,"omega")]);
	assert.equal(reads,1);assert.ok(b.excerpt?.includes("precise omega event"));assert.equal(a.documentText,undefined);
});
test("excerpt-only providers cannot exceed actual read quota by changing focus",async()=>{
	let reads=0;const scope=createResearchTurnScope("direct",search,async url=>{reads++;return{url,excerpt:"bounded"};});
	const results=await scope.webResearch!(["topic"],3);const url=results[0].results![0].url;
	await scope.webOpen!(url,"alpha");assert.ok((await scope.webOpen!(url,"omega")).rejected);assert.equal(reads,1);
});
test("a user-supplied source can be read directly without forcing a search round",async()=>{
	let calls=0;const scope=createResearchTurnScope("direct",undefined,async url=>{calls++;return{url,excerpt:"exact supplied source"};},undefined,()=>true,undefined,["https://official.test/source"]);
	assert.ok(scope.webOpen);assert.equal(scope.webResearch,undefined);assert.equal((await scope.webOpen!("https://official.test/source","")).excerpt,"exact supplied source");assert.ok((await scope.webOpen!("https://other.test/source","")).rejected);assert.equal(calls,1);
});
test("concurrent explicit freshness requests still share the same in-flight query",async()=>{
 let calls=0,release!:(rows:any[])=>void;const scope=createResearchTurnScope("direct",async()=>{calls++;return new Promise(r=>{release=r;});});
 const first=scope.webResearch!(["public fact"],3,undefined,true),second=scope.webResearch!(["public fact"],3,undefined,true);release(await search(["public fact"]));await Promise.all([first,second]);assert.equal(calls,1);
});
test("a canceled request cannot authorize its late receipt to another subscriber",async()=>{
 let release!:(rows:any[])=>void;const c=new AbortController();const scope=createResearchTurnScope("direct",async()=>new Promise(r=>{release=r;}));
 const first=scope.webResearch!(["public fact"],3,c.signal),other=scope.webResearch!(["public fact"],3);c.abort();release(await search(["public fact"]));assert.ok((await first)[0].rejected);assert.ok((await other)[0].rejected);
});
test("canceling a network attempt does not refund an unlimited retry allowance",async()=>{
 let calls=0;const scope=createResearchTurnScope("direct",async queries=>{calls++;await new Promise(r=>setTimeout(r,5));return search(queries);});
 for(let i=0;i<2;i++){const c=new AbortController();const pending=scope.webResearch!(["public canceled fact"],3,c.signal);c.abort();await pending;await new Promise(r=>setTimeout(r,10));}
 assert.ok((await scope.webResearch!(["public canceled fact"],3))[0].rejected);assert.equal(calls,2);
});
