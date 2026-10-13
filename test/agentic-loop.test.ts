import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgenticResearch, sanitizeClaims, type ResearchAdapters, type ResearchDecision, type ResearchRunOptions, type Evidence } from "../src/research/agentic-loop.ts";

const canon: Evidence = { id: "local:c1", questionId: "q", origin: "canon", title: "第一章", locator: "chunk:7:30-35", sourceRevision: "v1", excerpt: "当时尚未知情", scopeKey: "branch:v1", sourceChecked: true };
const page: Evidence = { id: "web:w1", questionId: "q", origin: "web-page", title: "Original source", locator: "https://example.org/a#p2", sourceUrl: "https://example.org/a", excerpt: "Historical example", scopeKey: "branch:v1", sourceChecked: true };
const opts: ResearchRunOptions = { mode: "director", scope: {key:"branch:v1",allowWeb:true}, questions: [{id:"q",text:"人物当时知道什么",important:true}] };

function adapter(script: ResearchDecision[], over: Partial<ResearchAdapters> = {}): ResearchAdapters {
  let index = 0;
  return {
    nextDecision: async () => script[index++] ?? {action:"finish",claims:[],gaps:[{questionId:"q",reason:"未查到"}]},
    findLocal: async () => [canon],
    searchPublic: async queries => queries.map((query,i)=>({id:"r"+i,query,title:"Source",url:"https://example.org/a",snippet:"Only a snippet"})),
    openPublic: async () => [page],
    authorizePublicQuery: () => true,
    isCurrentScope: () => true,
    ...over,
  };
}
test("agent reuses local canon and avoids public search when sufficient",async()=>{
  let network = 0;
  const result = await runAgenticResearch(opts,adapter([
    {action:"local",questionId:"q",query:"人物 知情"},
    {action:"finish",claims:[{questionId:"q",text:"当时尚未知情",kind:"canon",verdict:"supported",evidenceIds:["local:c1"]}],gaps:[]},
  ],{ searchPublic: async()=>{network++;return [];} }));
  assert.equal(result.stop,"sufficient");assert.equal(result.claims[0].verdict,"supported");assert.equal(network,0);
});
test("model receives search receipts and can decide to open source next",async()=>{
  const result=await runAgenticResearch(opts,adapter([
    {action:"search",questionId:"q",queries:["history evidence"]},
    {action:"open",questionId:"q",url:"https://example.org/a",focus:"historical example"},
    {action:"finish",claims:[{questionId:"q",text:"Historical example",kind:"external",verdict:"supported",evidenceIds:["web:w1"]}],gaps:[]}
  ]));
  assert.equal(result.stop,"sufficient"); assert.equal(result.used.publicQueries,1);assert.equal(result.used.sourceOpens,1);
  assert.deepEqual(result.receipts.map(r=>r.type),["search","open"]);
});
test("search snippet cannot turn into definitive canon and creates a gap",async()=>{
  const result=await runAgenticResearch(opts,adapter([
    {action:"search",questionId:"q",queries:["character relation"]},
    {action:"finish",claims:[{questionId:"q",text:"Definite canon answer",kind:"canon",verdict:"supported",evidenceIds:["missing"]}],gaps:[]}
  ]));
  assert.equal(result.claims[0].verdict,"unknown");assert.equal(result.gaps.length,1);assert.equal(result.stop,"gaps");
});
test("off/manual host gate prevents any public query",async()=>{
  let called=0;
  const result=await runAgenticResearch({...opts,scope:{...opts.scope,allowWeb:false}},adapter([
    {action:"search",questionId:"q",queries:["private-name lore"]},
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"private"}]},
  ],{searchPublic:async()=>{called++;return[];}}));
  assert.equal(called,0); assert.equal(result.receipts[0].type,"rejected");
});
test("one private query rejects the whole proposed batch before send",async()=>{
  let called=0;
  const result=await runAgenticResearch(opts,adapter([
    {action:"search",questionId:"q",queries:["public history","private identity"]},
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"blocked"}]},
  ],{authorizePublicQuery:q=>q!=="private identity",searchPublic:async()=>{called++;return[];}}));
  assert.equal(called,0);assert.equal(result.used.publicQueries,0);
});
test("unknown URL cannot be opened without search/user authorization",async()=>{
  let reads=0;
  const result=await runAgenticResearch(opts,adapter([
    {action:"open",questionId:"q",url:"https://evil.test/private",focus:"anything"},
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"no source"}]},
  ],{openPublic:async()=>{reads++;return[];}}));
  assert.equal(reads,0);assert.equal(result.receipts[0].type,"rejected");
});
test("branch change after awaited tool discards stale evidence",async()=>{
  let current=true;
  const result=await runAgenticResearch(opts,adapter([
    {action:"local",questionId:"q",query:"timeline"}
  ],{isCurrentScope:()=>current,findLocal:async()=>{current=false;return[canon];}}));
  assert.equal(result.stop,"stale-scope");assert.equal(result.evidence.length,0);
});
test("supported requires a checked locator, compatible kind and question",()=>{
  const unchecked={...page,sourceChecked:false};
  const claims=sanitizeClaims([
    {questionId:"q",text:"canon from web",kind:"canon",verdict:"supported",evidenceIds:["web:w1"]},
    {questionId:"q",text:"unchecked web",kind:"external",verdict:"supported",evidenceIds:["web:w1"]},
    {questionId:"q",text:"exact canon",kind:"canon",verdict:"supported",evidenceIds:["local:c1"]},
  ],[canon,unchecked]);
  assert.deepEqual(claims.map(c=>c.verdict),["unknown","unknown","supported"]);
});
test("director cannot exceed nine unique web queries",async()=>{
  let count=0;
  const script: ResearchDecision[]=[];
  for(let i=0;i<13;i++)script.push({action:"search",questionId:"q",queries:["public"+(i*2),"public"+(i*2+1)]});
  const result=await runAgenticResearch(opts,adapter(script,{searchPublic:async queries=>{count+=queries.length;return[];}}));
  assert.equal(count,9);assert.equal(result.used.publicQueries,9);assert.equal(result.stop,"limits");
});
test("direct finishes without network when no evidence needed",async()=>{
  const result=await runAgenticResearch({...opts,mode:"direct"},adapter([
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"uncertain"}]}
  ]));
  assert.equal(result.used.localLookups,0);assert.equal(result.used.publicQueries,0);assert.equal(result.stop,"gaps");
});
test("noncooperative model provider cannot block research deadline",async()=>{
  const result=await runAgenticResearch({...opts,deadlineMs:15},adapter([],
    {nextDecision:async()=>new Promise<ResearchDecision>(()=>{})}));
  assert.equal(result.stop,"limits");assert.equal(result.evidence.length,0);
});
test("explicit user URL can be read without searching but still uses host reader",async()=>{
  let reads=0;
  const result=await runAgenticResearch({...opts,userProvidedUrls:["https://example.org/a"]},adapter([
    {action:"open",questionId:"q",url:"https://example.org/a",focus:"fact"},
    {action:"finish",claims:[{questionId:"q",text:"Historical fact",kind:"external",verdict:"supported",evidenceIds:["web:w1"]}],gaps:[]}
  ],{openPublic:async()=>{reads++;return[page];}}));
  assert.equal(reads,1);assert.equal(result.used.publicQueries,0);assert.equal(result.stop,"sufficient");
});


test("source URLs belong to the research question that discovered them",async()=>{
  const many = {...opts,questions:[...opts.questions,{id:"q2",text:"other fact",important:false}]};
  let opened=0;
  const result=await runAgenticResearch(many,adapter([
    {action:"search",questionId:"q",queries:["history"]},
    {action:"open",questionId:"q2",url:"https://example.org/a",focus:"different question"},
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"not checked"}]},
  ],{openPublic:async()=>{opened++;return[page];}}));
  assert.equal(opened,0);
  assert.equal(result.receipts[1].type,"rejected");
});
test("web evidence must match exact URL of the opened trusted reader",async()=>{
  const result=await runAgenticResearch(opts,adapter([
    {action:"search",questionId:"q",queries:["history"]},
    {action:"open",questionId:"q",url:"https://example.org/a",focus:"source"},
    {action:"finish",claims:[{questionId:"q",text:"source says so",kind:"external",verdict:"supported",evidenceIds:["web:w1"]}],gaps:[]},
  ],{openPublic:async()=>[{...page,sourceUrl:"https://other.org/fabricated"}]}));
  assert.equal(result.stop,"gaps");
  assert.equal(result.evidence.length,0);
  assert.equal(result.claims[0].verdict,"unknown");
});
test("model cannot create a claim outside declared research questions",async()=>{
  const result=await runAgenticResearch(opts,adapter([
    {action:"finish",claims:[
      {questionId:"other",text:"invented",kind:"external",verdict:"supported",evidenceIds:["web:w1"]},
    ],gaps:[]},
  ]));
  assert.equal(result.claims.length,0);
  assert.equal(result.gaps[0].questionId,"q");
});
test("results returned by untrusted search adapters stay bounded",async()=>{
  let snapshotCandidates=0;
  const result=await runAgenticResearch(opts,adapter([],{
    nextDecision:async snapshot=>{
      if (!snapshot.receipts.length) return {action:"search",questionId:"q",queries:["history"]};
      const r=snapshot.receipts[0];
      if(r.type==="search") snapshotCandidates=r.candidates.length;
      return {action:"finish",claims:[],gaps:[{questionId:"q",reason:"reference missing"}]};
    },
    searchPublic:async()=>Array.from({length:500},(_,i)=>({
      id:String(i),query:"history",title:"Title".repeat(500),url:"https://example.org/"+i,snippet:"S".repeat(2000)
    }))
  }));
  assert.equal(snapshotCandidates,12);
  assert.ok(result.receipts[0].type==="search");
  if(result.receipts[0].type==="search") {
    assert.ok(result.receipts[0].candidates.every(c=>c.title.length<=200&&c.snippet.length<=450));
  }
});
test("canon supported status requires immutable source revision; inference remains inference",()=>{
  const noRev={...canon,sourceRevision:undefined};
  const checked=sanitizeClaims([
    {questionId:"q",text:"unversioned",kind:"canon",verdict:"supported",evidenceIds:["local:c1"]},
    {questionId:"q",text:"author interpretation",kind:"interpretation",verdict:"supported",evidenceIds:["local:c1"]},
  ],[noRev]);
  assert.deepEqual(checked.map(c=>c.verdict),["unknown","unknown"]);
});
test("failed asynchronous research adapter terminates explicitly",async()=>{
  const result=await runAgenticResearch(opts,adapter([],{
    nextDecision:async()=>{throw new Error("provider rejected");}
  }));
  assert.equal(result.stop,"adapter-error");
  assert.ok(result.receipts.some(r=>r.type==="rejected"));
});
test("invalid empty public queries must not reach search provider",async()=>{
  let sends=0;
  const result=await runAgenticResearch(opts,adapter([
    {action:"search",questionId:"q",queries:["  ",""]},
    {action:"finish",claims:[],gaps:[{questionId:"q",reason:"unresolved"}]}
  ],{searchPublic:async()=>{sends++;return[];}}));
  assert.equal(sends,0);
  assert.equal(result.used.publicQueries,0);
});

test("same immutable source supports two questions with independent citation IDs",async()=>{
  const options={...opts,questions:[...opts.questions,{id:"q2",text:"same source other detail",important:false}]};
  const result=await runAgenticResearch(options,adapter([
    {action:"local",questionId:"q",query:"same doc"},
    {action:"local",questionId:"q2",query:"same doc"},
    {action:"local",questionId:"q",query:"same doc"},
    {action:"finish",claims:[
      {questionId:"q",text:"Original fact",kind:"canon",verdict:"supported",evidenceIds:["local:c1"]},
      {questionId:"q2",text:"Reused fact",kind:"canon",verdict:"supported",evidenceIds:['["q2","local:c1"]']},
    ],gaps:[]},
  ],{findLocal:async(id)=>[{...canon,questionId:id}]}));
  assert.equal(result.stop,"sufficient");
  assert.equal(result.evidence.length,2);
  assert.deepEqual(result.claims.map(c=>c.verdict),["supported","supported"]);
});
test("a huge local adapter result cannot overload the model evidence snapshot",async()=>{
  let maxSeen=0, steps=0, nextId=0;
  const result=await runAgenticResearch(opts,adapter([],{nextDecision:async snap=>{
    maxSeen=Math.max(maxSeen,snap.evidence.length);
    return ++steps<=8
      ? {action:"local",questionId:"q",query:"source"}
      : {action:"finish",claims:[],gaps:[{questionId:"q",reason:"unknown"}]};
  },findLocal:async()=>Array.from({length:200},()=>({...canon,id:"source:"+(nextId++),excerpt:"A".repeat(10000)}))}));
  assert.equal(result.evidence.length,32);
  assert.ok(maxSeen<=32);
  assert.ok(result.evidence.every(x=>x.excerpt.length<=4000));
});

test("oversized model claim cannot conceal unsupported references after truncation",()=>{
  const checked=sanitizeClaims([
    {questionId:"q",text:"x".repeat(3000),kind:"canon",verdict:"supported",evidenceIds:["local:c1"]},
    {questionId:"q",text:"claim",kind:"canon",verdict:"supported",evidenceIds:[
      ...Array.from({length:16},()=>"local:c1"),"fabricated:missing"
    ]},
  ],[canon]);
  assert.deepEqual(checked.map(c=>c.verdict),["unknown","unknown"]);
  assert.ok(checked[0].text.length<=1200);
  assert.ok(checked[1].evidenceIds.length<=16);
});
