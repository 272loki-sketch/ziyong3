import test from "node:test";import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
import {createHash} from "node:crypto";
import {novelNodeId,type NovelSource} from "../src/novel-play/source.ts";
import {buildNovelPackage} from "../src/novel-play/canon.ts";
import {saveNovelPackage} from "../src/novel-play/store.ts";
import {researchEngineFixture as fixture,researchDirectorScript as director} from "./support/research-engine-fixture.ts";
const call=(query:string,scope="visible")=>({calls:[{name:"canon_research",args:{query,scope,max_results:6}}]});
function canonFixture(mode:"direct"|"director", options: { sideGate?: (id:string, context:any)=>Promise<void> } = {}) {
	const cwd=mkdtempSync(join(tmpdir(),"liyuan-canon-engine-"));
	const sourceText="第一章\n雨桥相遇。她尚不知道真相。\n\n第二章\n秋日揭晓。她此时才得知真相。\n\n第三章\n隐藏秘密。";
	const source:NovelSource={version:1,docId:"synthetic-work",title:"Synthetic original work",fingerprint:createHash("sha256").update(sourceText).digest("hex"),chunkChars:1000,chunks:[{index:0,chars:sourceText.length,chapters:["第一章","第二章","第三章"],text:sourceText}]};
	const quotes=["雨桥相遇。她尚不知道真相。","秋日揭晓。她此时才得知真相。","隐藏秘密。"];
	const refs=quotes.map(quote=>({chunkIndex:0,start:sourceText.indexOf(quote),end:sourceText.indexOf(quote)+quote.length,quote}));
	const nodes=refs.map((ref,i)=>({id:novelNodeId(source,ref,`event-${i}`),key:`event-${i}`,stageId:"stage",order:i,title:["雨桥相遇","秋日揭晓","隐藏秘密"][i],summary:"Synthetic model interpretation, not source fact",visibility:(i===2?"secret":"public") as "public"|"secret",dependsOn:i===1?[novelNodeId(source,refs[0],"event-0")]:[],sourceRefs:[ref]}));
	const pkg=buildNovelPackage(source,[{id:"stage",order:0,title:"Synthetic volume"}],nodes);saveNovelPackage(cwd,source,pkg);
	const binding={docId:source.docId,revision:pkg.revision,startNodeId:nodes[0].id,position:"after" as const,anchorKind:"node" as const};
	const rawCard={data:{name:"SyntheticPrivateActor",description:"Synthetic canon role",first_mes:"Synthetic greeting",extensions:{liyuanNovelPlay:binding}}};
	const body="Synthetic branch story: the bridge encounter was changed; she does not yet know the future revelation.";
	const f=fixture(mode,[call("雨桥相遇"),call("秋日揭晓"),call("秋日揭晓","author-planning"),...(mode==="director"?director(body):[{text:body}])],{cwd,rawCard,sideGate:options.sideGate});
	return{...f,source,pkg,binding,body};
}
for(const mode of ["direct","director"] as const)test(`actual ${mode} canon tool binds package, locators, chapter, future knowledge and branch conflicts`,async()=>{
	const f=canonFixture(mode);
	try{
		const change=f.sm.appendMessage({role:"user",content:"Synthetic branch changed the encounter.",timestamp:Date.now()} as never);
		f.sm.appendCustomEntry("rp-novel-play",{version:1,card:f.binding,progress:{packageRevision:f.pkg.revision,nodeId:f.pkg.nodes[0].id,position:"after"},conflicts:[{packageRevision:f.pkg.revision,nodeId:f.pkg.nodes[0].id,sourceEntryIds:[change]}],preparedFromLeafId:change});f.sm.flush();
		await f.engine.performTurn("Use local original evidence; preserve my changed synthetic branch and current knowledge.");
		const writer=f.requests.filter(x=>x.model==="writer");
		const receipts=writer.flatMap(row=>row.context.messages.filter((m:any)=>m.role==="toolResult"&&m.toolName==="canon_research").map((m:any)=>m.content[0].text));
		const parsed=receipts.filter((value:string)=>value.startsWith("{")).map((value:string)=>JSON.parse(value));
		assert.ok(parsed.some((row:any)=>row.hits.some((hit:any)=>hit.chapter==="第一章"&&hit.quote==="雨桥相遇。她尚不知道真相。"&&hit.branchConflictSourceIds.includes(change))),"current source evidence and branch conflict must be delivered");
		assert.ok(parsed.some((row:any)=>row.hits.some((hit:any)=>hit.chapter==="第二章"&&hit.timeline==="future-for-author-planning"&&hit.characterKnowledge==="not-established")));
		assert.ok(receipts.some((value:string)=>value.includes("不能据此断言原著没有")));
		for(const row of parsed)for(const hit of row.hits){assert.equal(f.source.chunks[hit.chunkIndex].text.slice(hit.start,hit.end),hit.quote);assert.equal(hit.packageRevision,f.pkg.revision);assert.equal(hit.sourceFingerprint,f.source.fingerprint);assert.notEqual(hit.title,"隐藏秘密");}
		const saved=f.sm.getBranch().filter((e:any)=>e.message?.role==="assistant").at(-1) as any;
		assert.equal(saved.message.details.rpAuthorDraft,f.body);assert.equal(f.sm.getBranch().filter((e:any)=>e.message?.role==="assistant").length,1);
		if(mode==="director"){const review=f.requests.find(x=>x.model==="directorReviewFacts")!;assert.match(JSON.stringify(review.context),/reference-not-branch-fact/);assert.match(JSON.stringify(review.context),/sourceFingerprint/);}
	}finally{f.cleanup();}
});
test("same-path card/package replacement is a stale binding receipt, not an empty canon search",async()=>{
 let changed=false;let f!:ReturnType<typeof canonFixture>;
 f=canonFixture("direct",{sideGate:async id=>{if(id!=="writer"||changed)return;changed=true;const path=join(f.cwd,"card.json"),card=JSON.parse(readFileSync(path,"utf8"));card.data.extensions.liyuanNovelPlay.revision="different-synthetic-revision";writeFileSync(path,JSON.stringify(card));}});
 try{await f.engine.performTurn("Check the synthetic canon with a concurrent version change.");const receipts=f.requests.filter(row=>row.model==="writer").flatMap(row=>row.context.messages.filter((m:any)=>m.role==="toolResult"&&m.toolName==="canon_research").map((m:any)=>m.content[0].text));assert.ok(receipts.some((text:string)=>text.includes("作品版本已失效")));assert.ok(receipts.every((text:string)=>!text.startsWith('{"kind":"canon-source-evidence"')));}finally{f.cleanup();}
});

test("actual direct canon index miss falls back to the same immutable full source without another model step", async () => {
  const f=canonFixture("direct");
  try {
    // The event span intentionally excludes the clothing detail that exists in its chapter.
    const file=JSON.parse(readFileSync(join(f.cwd,"card.json"),"utf8"));
    const text="第一章\n她戴青色围巾，尚不知道真相。\n雨桥相遇。她尚不知道真相。\n\n第二章\n秋日揭晓。她此时才得知真相。\n\n第三章\n隐藏秘密。";
    const source={...f.source,fingerprint:createHash("sha256").update(text).digest("hex"),chunks:[{...f.source.chunks[0],chars:text.length,text}]};
    const nodes=f.pkg.nodes.map(node=>{const refs=node.sourceRefs.map(ref=>({...ref,start:text.indexOf(ref.quote),end:text.indexOf(ref.quote)+ref.quote.length}));return {...node,id:novelNodeId(source,refs[0],node.key),sourceRefs:refs};});
    // Use fresh IDs and dependencies in a new immutable revision, never patch an existing package.
    const rebuilt=buildNovelPackage(source,f.pkg.stages,nodes.map((node,i)=>({...node,dependsOn:i===1?[nodes[0].id]:[]})));
    saveNovelPackage(f.cwd,source,rebuilt);file.data.extensions.liyuanNovelPlay={...file.data.extensions.liyuanNovelPlay,revision:rebuilt.revision,startNodeId:rebuilt.nodes[0].id};
    writeFileSync(join(f.cwd,"card.json"),JSON.stringify(file));
    f.responses.splice(0,f.responses.length,call("青色围巾"),call("秋日揭晓"),call("隐藏秘密","author-planning"),{text:"第一章青色围巾，当前尚不知真相；未来及秘密没有泄露。"});
    await f.engine.performTurn("核对当前围巾细节");
    const last=f.requests.filter(row=>row.model==="writer").at(-1)!;
    const receipts=last.context.messages.filter((m:any)=>m.role==="toolResult"&&m.toolName==="canon_research").map((m:any)=>JSON.parse(m.content[0].text));
    const hit=receipts[0].hits[0];assert.equal(receipts[0].coverage,"immutable-source-fulltext-fallback");
    assert.ok(hit.quote.includes("青色围巾"));assert.equal(hit.chapter,"第一章");assert.equal(source.chunks[hit.chunkIndex].text.slice(hit.start,hit.end),hit.quote);
    assert.equal(hit.sourceFingerprint,source.fingerprint);assert.equal(hit.packageRevision,rebuilt.revision);
    assert.equal(receipts[1].hits.length,0);assert.equal(receipts[2].hits.length,0);
    assert.equal(f.requests.filter(row=>row.model==="writer").length,4);
  } finally { f.cleanup(); }
});
