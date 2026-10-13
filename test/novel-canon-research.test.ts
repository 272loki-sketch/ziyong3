import assert from "node:assert/strict";
import { test } from "node:test";
import { searchVisibleCanonEvidence } from "../src/novel-play/research.ts";
import type { NovelPackage } from "../src/novel-play/canon.ts";
import type { NovelSource } from "../src/novel-play/source.ts";

const chapter = "第一事件发生。第二事件发生。秘密事件发生。";
const evidence = (quote: string) => ({ chunkIndex: 0, start: chapter.indexOf(quote), end: chapter.indexOf(quote)+quote.length, quote });
const source: NovelSource = {version:1,docId:"test-doc",title:"test",fingerprint:"fingerprint",
	chunkChars:100,chunks:[{index:0,chars:chapter.length,chapters:["第一章"],text:chapter}]};
const pkg: NovelPackage = {version:1,docId:"test-doc",revision:"revision",sourceFingerprint:"fingerprint",
	sourceChunkChars:100,stages:[{id:"stage",order:0,title:"第一阶段"}],nodes:[
		{id:"n1",key:"a",stageId:"stage",order:0,title:"第一事件",summary:"第一事件已经发生",
			visibility:"public",dependsOn:[],sourceRefs:[evidence("第一事件发生。")]},
		{id:"n2",key:"b",stageId:"stage",order:1,title:"第二事件",summary:"第二事件在未来发生",
			visibility:"public",dependsOn:["n1"],sourceRefs:[evidence("第二事件发生。")]},
		{id:"n3",key:"c",stageId:"stage",order:2,title:"秘密事件",summary:"隐藏情节",
			visibility:"secret",dependsOn:[],sourceRefs:[evidence("秘密事件发生。")]},
	]};
test("canon only reveals past public events before current anchor",()=>{
	const result=searchVisibleCanonEvidence(pkg,source,{packageRevision:"revision",nodeId:"n2",position:"before"},"事件",6);
	assert.deepEqual(result.map(x=>x.nodeId),["n1"]);
	assert.equal(result[0].quote,"第一事件发生。");
	assert.equal(result[0].chapter,"第一章");
});
test("canon can read current public event after current anchor",()=>{
	const result=searchVisibleCanonEvidence(pkg,source,{packageRevision:"revision",nodeId:"n2",position:"after"},"第二事件",6);
	assert.deepEqual(result.map(x=>x.nodeId),["n2"]);
});
test("canon source-end never exposes secret events",()=>{
	const result=searchVisibleCanonEvidence(pkg,source,{kind:"source-end",packageRevision:"revision"},"事件",6);
	assert.deepEqual(result.map(x=>x.nodeId),["n1","n2"]);
});
test("canon rejects package revision mismatch, bad offsets, and empty queries",()=>{
	assert.deepEqual(searchVisibleCanonEvidence(pkg,source,{kind:"source-end",packageRevision:"old"},"事件"),[]);
	assert.deepEqual(searchVisibleCanonEvidence(pkg,source,{kind:"source-end",packageRevision:"revision"},"  "),[]);
	const corrupted: NovelSource={...source,chunks:[{...source.chunks[0],text:"不存在的原文".padEnd(chapter.length," ")}]};
	assert.deepEqual(searchVisibleCanonEvidence(pkg,corrupted,{kind:"source-end",packageRevision:"revision"},"事件"),[]);
});

test("author-planning can read public future, not secret nodes or character knowledge",()=>{
	const hits=searchVisibleCanonEvidence(pkg,source,{packageRevision:"revision",nodeId:"n1",position:"before"},"第二事件",6,"author-planning");
	assert.equal(hits[0].nodeId,"n2");assert.equal(hits[0].timeline,"future-for-author-planning");
	assert.equal(hits[0].characterKnowledge,"not-established");
	assert.equal(searchVisibleCanonEvidence(pkg,source,{kind:"source-end",packageRevision:"revision"},"秘密",6,"author-planning").length,0);
});
test("all sourceRefs are ranked and exact offsets accompany the actually returned quote",()=>{
	const quote="第二事件发生。";
	const expanded={...pkg,nodes:[{...pkg.nodes[0],title:"合成节点",summary:"错误解释：第一章人物已经知道第三事件",sourceRefs:[evidence("第一事件发生。"),evidence("第一事件发生。"),evidence(quote)]}]};
	const hits=searchVisibleCanonEvidence(expanded,source,{kind:"source-end",packageRevision:"revision"},"第二事件",6);
	assert.equal(hits[0].quote,quote);assert.equal(source.chunks[0].text.slice(hits[0].start,hits[0].end),hits[0].quote);
	assert.equal(hits[0].packageRevision,pkg.revision);assert.equal(hits[0].sourceFingerprint,source.fingerprint);
	assert.equal(searchVisibleCanonEvidence(expanded,source,{kind:"source-end",packageRevision:"revision"},"第三事件",6).length,0,"model interpretation is not source evidence");
});
test("ambiguous multi-chapter chunks do not claim an exact chapter",()=>{
	const s={...source,chunks:[{...source.chunks[0],chapters:["第一章","第二章"]}]};
	const hits=searchVisibleCanonEvidence(pkg,s,{kind:"source-end",packageRevision:"revision"},"第一事件");
	assert.equal(hits[0].chapter,"");assert.deepEqual(hits[0].chapterCandidates,["第一章","第二章"]);
	assert.equal(searchVisibleCanonEvidence({...pkg,sourceChunkChars:101},source,{kind:"source-end",packageRevision:"revision"},"事件").length,0);
});
test("long quotes retain matching text with exact updated UTF-16 bounds",()=>{
	const long="序言".repeat(800)+"重要事实"+"后记".repeat(800);
	const s={...source,chunks:[{index:0,chars:long.length,chapters:["第二章"],text:long}]};
	const p={...pkg,nodes:[{...pkg.nodes[0],title:"长引文",sourceRefs:[{chunkIndex:0,start:0,end:long.length,quote:long}]}]};
	const hits=searchVisibleCanonEvidence(p,s,{kind:"source-end",packageRevision:"revision"},"重要事实");
	assert.ok(hits[0].quote.includes("重要事实"));assert.equal(long.slice(hits[0].start,hits[0].end),hits[0].quote);assert.ok(hits[0].quote.length<=900);
});
test("normalization matches full-width names without fabricating normalized source offsets",()=>{
	const long="前文".repeat(800)+"ＡＬＰＨＡ 在此得知真相。"+"后文".repeat(800);
	const s={...source,chunks:[{index:0,chars:long.length,chapters:["第二章"],text:long}]};
	const p={...pkg,nodes:[{...pkg.nodes[0],title:"长文",sourceRefs:[{chunkIndex:0,start:0,end:long.length,quote:long}]}]};
	const hits=searchVisibleCanonEvidence(p,s,{kind:"source-end",packageRevision:"revision"},"alpha");assert.ok(hits[0].quote.includes("ＡＬＰＨＡ"));assert.equal(long.slice(hits[0].start,hits[0].end),hits[0].quote);
});
test("EPUB source ingestion excludes script/style text before immutable evidence is built",async()=>{
	const{execFileSync}=await import("node:child_process");const{epubToText}=await import("../src/outline/corpus.ts");
	const body="雨桥相遇。她尚不知道真相。".repeat(20);
	const files={"META-INF/container.xml":'<container><rootfiles><rootfile full-path="book/content.opf"/></rootfiles></container>',"book/content.opf":'<package><manifest><item id="c1" href="chapter.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',"book/chapter.xhtml":`<html><head><style>SYNTHETIC_STYLE_NOT_STORY</style></head><body><h1>第一章</h1><script>SYNTHETIC_SCRIPT_NOT_CANON</script><p>${body}</p></body></html>`};
	const py="import sys,json,io,zipfile\nfiles=json.load(sys.stdin)\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_STORED) as z:\n for name,text in files.items(): z.writestr(name,text.encode('utf-8'))\nsys.stdout.buffer.write(b.getvalue())\n";
	const zip=execFileSync("python3",["-c",py],{input:JSON.stringify(files)});const text=epubToText(zip);
	assert.ok(text.includes(body));assert.doesNotMatch(text,/SYNTHETIC_STYLE_NOT_STORY|SYNTHETIC_SCRIPT_NOT_CANON/);
});
