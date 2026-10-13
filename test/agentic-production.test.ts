import test from "node:test";
import assert from "node:assert/strict";
import { createResearchSession } from "../src/research/session.ts";
import { createResearchTurnScope } from "../src/tools/research-scope.ts";
import { searchNovelFulltext } from "../src/novel-play/fulltext.ts";
import type { NovelPackage } from "../src/novel-play/canon.ts";
import type { NovelSource } from "../src/novel-play/source.ts";
import {
  researchEngineFixture as fixture,
  researchDirectorScript as director,
} from "./support/research-engine-fixture.ts";
const source: NovelSource = {
  version: 1,
  docId: "gold",
  title: "原创授权合成原文",
  fingerprint: "a".repeat(64),
  chunkChars: 10000,
  chunks: [
    {
      index: 0,
      chars: 0,
      chapters: ["第一章 初见", "第二章 消息"],
      text: "第一章 初见\n林舟戴着青色围巾。她尚未获知来信。\n第一事件发生。\n第二章 消息\n她收到来信，知道约定。\n秘密口令是紫花。",
    },
  ],
};
source.chunks[0].chars = source.chunks[0].text.length;
const ref = (quote: string) => ({
  chunkIndex: 0,
  start: source.chunks[0].text.indexOf(quote),
  end: source.chunks[0].text.indexOf(quote) + quote.length,
  quote,
});
const pkg: NovelPackage = {
  version: 1,
  revision: "r1",
  docId: source.docId,
  sourceFingerprint: source.fingerprint,
  sourceChunkChars: source.chunkChars,
  stages: [{ id: "s", order: 0, title: "第一卷" }],
  nodes: [
    {
      id: "n1",
      key: "n1",
      stageId: "s",
      order: 0,
      title: "首次相遇",
      summary: "summary not source",
      visibility: "public",
      dependsOn: [],
      sourceRefs: [ref("第一事件发生。")],
    },
    {
      id: "n2",
      key: "n2",
      stageId: "s",
      order: 1,
      title: "来信",
      summary: "summary not source",
      visibility: "public",
      dependsOn: ["n1"],
      sourceRefs: [ref("她收到来信，知道约定。")],
    },
    {
      id: "secret",
      key: "secret",
      stageId: "s",
      order: 2,
      title: "秘密",
      summary: "private",
      visibility: "secret",
      dependsOn: [],
      sourceRefs: [ref("秘密口令是紫花。")],
    },
  ],
};
test("全文覆盖事件索引未提取的细节，章节与UTF16定位严格，未来和秘密隔离", () => {
  const ctx = {
    package: pkg,
    anchor: { packageRevision: "r1", nodeId: "n1", position: "after" as const },
    conflicts: [{ nodeId: "n1", sourceEntryIds: ["fork-fact"] }],
  };
  const [hit] = searchNovelFulltext(source, "青色围巾", 3, "visible", ctx);
  assert.ok(hit.quote.includes("青色围巾"));
  assert.equal(hit.chapter, "第一章 初见");
  assert.equal(source.chunks[0].text.slice(hit.start, hit.end), hit.quote);
  assert.equal(hit.characterKnowledge, "not-established");
  assert.deepEqual(hit.branchConflictSourceIds, ["fork-fact"]);
  assert.equal(
    searchNovelFulltext(source, "收到来信", 3, "visible", ctx).length,
    0,
  );
  const future = searchNovelFulltext(
    source,
    "收到来信",
    3,
    "author-planning",
    ctx,
  );
  assert.equal(future[0].timeline, "future-for-author-planning");
  assert.equal(future[0].characterKnowledge, "not-established");
  assert.equal(
    searchNovelFulltext(source, "秘密口令", 3, "author-planning", ctx).length,
    0,
  );
  assert.ok(future.every((h) => !h.quote.includes("紫花")));
  assert.deepEqual(
    searchNovelFulltext(source, "围巾", 3, "visible", {
      ...ctx,
      anchor: { ...ctx.anchor, packageRevision: "other" },
    }),
    [],
  );
});
test("无作品事件映射的文档只给作者规划，不冒充角色知情", () => {
  assert.deepEqual(searchNovelFulltext(source, "围巾"), []);
  assert.equal(
    searchNovelFulltext(source, "围巾", 3, "author-planning")[0].timeline,
    "unmapped-author-only",
  );
});
test("来源URL错配不能形成证据，真实reader hash和摘录偏移才可引用", async () => {
  const url = "https://source.test/a",
    host = createResearchTurnScope(
      "direct",
      undefined,
      async () => ({
        url: "https://other.test/a",
        documentText: "hello evidence",
      }),
      undefined,
      () => true,
      undefined,
      [url],
    );
  assert.ok((await host.webOpen!(url, "evidence")).rejected);
  const good = createResearchTurnScope(
    "direct",
    undefined,
    async () => ({ url, documentText: " hello evidence\n" }),
    undefined,
    () => true,
    undefined,
    [url],
  );
  const row = await good.webOpen!(url, "evidence");
  assert.equal(row.locator!.end - row.locator!.start, row.excerpt!.length);
  assert.equal(row.sourceFingerprint!.length, 64);
  const session = createResearchSession("branch", "task", () => true, [url]);
  const ids = session.accept(
    "web_open",
    { url },
    { kind: "web-source-excerpt", trust: "external-untrusted", ...row },
  );
  assert.equal(ids.length, 1);
  const assessed = JSON.parse(
    session.record({
      action: "finish",
      claims: [
        {
          questionId: "task",
          text: "hello",
          kind: "external",
          verdict: "supported",
          evidenceIds: ids,
        },
      ],
      gaps: [],
    }).text,
  );
  assert.equal(assessed.claims[0].verdict, "supported");
});
test("question授权、模型伪造引用、心理推演和未知项不能伪装来源确证", () => {
  const session = createResearchSession("b", "test", () => true);
  session.record({
    action: "plan",
    questions: [
      { id: "q1", text: "date", important: true },
      { id: "q2", text: "other", important: true },
    ],
  });
  session.accept("web_research", { question_id: "q1", queries: ["date"] }, [
    { query: "date", results: [{ url: "https://source.test/a" }] },
  ]);
  assert.equal(
    session.canOpen({ question_id: "q2", url: "https://source.test/a" }),
    false,
  );
  const ids = session.accept("canon_research", { question_id: "q1" }, [
    {
      ...ref("第一事件发生。"),
      docId: "gold",
      sourceFingerprint: source.fingerprint,
      packageRevision: "r1",
    },
  ]);
  const r = JSON.parse(
    session.record({
      action: "finish",
      claims: [
        {
          questionId: "q1",
          text: "fake",
          kind: "canon",
          verdict: "supported",
          evidenceIds: ["model-forged"],
        },
        {
          questionId: "q2",
          text: "cross question",
          kind: "canon",
          verdict: "supported",
          evidenceIds: ids,
        },
        {
          questionId: "q1",
          text: "motivation",
          kind: "interpretation",
          verdict: "supported",
          evidenceIds: ids,
        },
      ],
      gaps: [],
    }).text,
  );
  assert.deepEqual(
    r.claims.map((c: any) => c.verdict),
    ["unknown", "unknown", "inferred"],
  );
  assert.equal(r.stop, "gaps");
});
test("同一来源分别绑定多个问题；出处复用不丢失也不跨问题背书", () => {
  const session = createResearchSession("b", "t", () => true);
  session.record({
    action: "plan",
    questions: [
      { id: "q", text: "q" },
      { id: "r", text: "r" },
    ],
  });
  const data = [
    {
      ...ref("第一事件发生。"),
      docId: "gold",
      sourceFingerprint: source.fingerprint,
      packageRevision: "r1",
    },
  ];
  const a = session.accept("canon_research", { question_id: "q" }, data),
    b = session.accept("canon_research", { question_id: "r" }, data);
  assert.notEqual(a[0], b[0]);
  assert.equal(session.summary()!.evidence, 2);
});
test("过期分支拒绝模型迟到结论且不转发旧证据", () => {
  let current = true;
  const session = createResearchSession("b", "t", () => current);
  session.accept("canon_research", {}, [
    {
      ...ref("第一事件发生。"),
      docId: "gold",
      sourceFingerprint: source.fingerprint,
    },
  ]);
  current = false;
  assert.equal(
    session.record({ action: "finish", claims: [], gaps: [] }).isError,
    true,
  );
  assert.deepEqual(session.sources(), []);
});
const call = (name: string, args: Record<string, unknown>) => ({
  calls: [{ name, args }],
});
test("真实Stage普通直出无研究模型/外网，研究按需而非前置阶段", async () => {
  let net = 0;
  const f = fixture("direct", [{ text: "轻松的原创对话。" }], {
    webResearch: async () => {
      net++;
      return [];
    },
  });
  try {
    await f.engine.performTurn("继续合成互动。");
    assert.equal(net, 0);
    assert.equal(f.requests.filter((r) => r.model === "writer").length, 1);
    const saved: any = f.sm
      .getBranch()
      .find((e: any) => e.message?.role === "assistant");
    assert.equal(
      saved.message.details.rpGenerationWorkflow.research,
      undefined,
    );
  } finally {
    f.cleanup();
  }
});
test("真实Stage导演下一查询由真实读源冲突决定，来源进原3/2/2，无第二作者", async () => {
  const urls = ["https://source.test/old", "https://source.test/archive"];
  let queries: string[] = [];
  const steps = [
    call("research_record", {
      action: "plan",
      questions: [{ id: "date", text: "官方年代是什么", important: true }],
    }),
    call("web_research", {
      question_id: "date",
      queries: ["official historical date"],
    }),
  ];
  const f = fixture("director", steps, {
    worldText: "在这个原创世界，天上有两个月亮。",
    webResearch: async (q) => {
      queries.push(...q);
      return q.map((query) => ({
        query,
        results: [
          {
            title: "source",
            url: urls[queries.length - 1],
            snippet: "discovery only",
          },
        ],
      }));
    },
    webOpen: async (url) => ({
      url,
      documentText:
        url === urls[0]
          ? "二手来源写1900，注释提示档案应为1901。"
          : "官方档案原文：1901年。",
    }),
    nextResponse: (ctx) => {
      const last = [...ctx.messages]
        .reverse()
        .find((m: any) => m.role === "toolResult");
      if (last?.toolName === "web_research")
        return call("web_open", {
          question_id: "date",
          url: urls[queries.length - 1],
          focus: "年代",
        });
      else if (last?.toolName === "web_open") {
        const r = JSON.parse(last.content[0].text);
        if (r.tool_receipt.includes("二手来源"))
          return call("web_research", {
            question_id: "date",
            queries: ["1901 archive original historical date"],
          });
        else {
          f.responses.push(...director("合成角色继续生活在两个月亮的世界里。"));
          return call("research_record", {
            action: "finish",
            claims: [
              {
                questionId: "date",
                text: "档案记为1901，二手资料1900不可靠。",
                kind: "external",
                verdict: "supported",
                evidenceIds: r.evidence_ids,
              },
            ],
            gaps: [],
          });
        }
      }
      throw new Error("unexpected model context");
    },
  });
  try {
    await f.engine.performTurn("查公开年代，不改变我的世界书。");
    assert.deepEqual(queries, [
      "official historical date",
      "1901 archive original historical date",
    ]);
    assert.equal(
      f.requests.filter((r) => r.model === "directorIdeas").length,
      2,
    );
    assert.equal(
      f.requests.filter((r) => r.model === "directorReviewFacts").length,
      1,
    );
    assert.match(
      JSON.stringify(
        f.requests.find((r) => r.model === "directorReviewFacts")!.context,
      ),
      /1901/,
    );
    const saved: any = f.sm
      .getBranch()
      .filter((e: any) => e.message?.role === "assistant")
      .at(-1);
    assert.equal(
      saved.message.details.rpGenerationWorkflow.research.stop,
      "sufficient",
    );
    assert.equal(
      saved.message.details.rpAuthorDraft,
      "合成角色继续生活在两个月亮的世界里。",
    );
  } finally {
    f.cleanup();
  }
});

test("首次实际检索可声明问题，空白/重复改名/越界问题仍拒绝，finish可复用本次assessment", () => {
  const session = createResearchSession("b", "task text", () => true);
  assert.equal(
    session.declareReadQuestion("canon_research", {
      question_id: "scarf",
      query: "围巾",
    }),
    true,
  );
  assert.equal(session.validQuestion({ question_id: "scarf" }), true);
  assert.equal(
    session.declareReadQuestion("web_open", {
      question_id: "fake",
      url: "https://other.test/x",
    }),
    false,
  );
  const ids = session.accept("canon_research", { question_id: "scarf" }, [
    {
      ...ref("第一事件发生。"),
      docId: "gold",
      sourceFingerprint: source.fingerprint,
      packageRevision: "r1",
    },
  ]);
  session.record({
    action: "assess",
    claims: [
      {
        questionId: "scarf",
        text: "fact",
        kind: "canon",
        verdict: "supported",
        evidenceIds: ids,
      },
    ],
    gaps: [],
  });
  assert.equal(
    JSON.parse(session.record({ action: "finish" }).text).stop,
    "sufficient",
  );
  assert.equal(
    session.record({
      action: "plan",
      questions: [{ id: "scarf", text: "replaced" }],
    }).isError,
    true,
  );
});
test("恶意超大候选在host边界有界，未知来源推演也不能自报可靠", async () => {
  const scope = createResearchTurnScope("director", async (qs) =>
    qs.map((query) => ({
      query,
      results: Array.from({ length: 500 }, (_, i) => ({
        url: "https://source.test/" + i,
        title: "A".repeat(5000),
        snippet: "B".repeat(9000),
      })),
    })),
  );
  const rows = await scope.webResearch!(["public query"], 5);
  assert.equal(rows[0].results!.length, 5);
  assert.ok(
    rows[0].results!.every(
      (r) => r.title.length <= 200 && r.snippet.length <= 450,
    ),
  );
  const session = createResearchSession("b", "task", () => true);
  const r = JSON.parse(
    session.record({
      action: "finish",
      claims: [
        {
          questionId: "task",
          text: "motive",
          kind: "interpretation",
          verdict: "inferred",
          evidenceIds: ["fabricated"],
        },
      ],
      gaps: [],
    }).text,
  );
  assert.equal(r.claims[0].verdict, "unknown");
  assert.equal(r.stop, "gaps");
});
test("全文的精确命中有章节边界，不因相邻章上下文跨越造成错误章引用", () => {
  const hits = searchNovelFulltext(source, "收到来信", 3, "author-planning", {
    package: pkg,
    anchor: { kind: "source-end", packageRevision: "r1" },
  });
  assert.equal(hits[0].chapter, "第二章 消息");
  assert.ok(!hits[0].quote.includes("第一章 初见"));
  assert.ok(!hits[0].quote.includes("紫花"));
});

test("跨换行/兼容Unicode查询仍引用原始UTF16文本，不用正规化字符伪造offset", () => {
  const text =
    "CHAPTER VI\nShe was perfectly\nunaware of this. ＡＬＰＨＡ smiled.";
  const source2 = {
    ...source,
    chunks: [{ index: 0, chars: text.length, chapters: ["CHAPTER VI"], text }],
  };
  for (const query of ["perfectly unaware", "alpha"]) {
    const [hit] = searchNovelFulltext(source2, query, 3, "author-planning");
    assert.ok(hit);
    assert.equal(text.slice(hit.start, hit.end), hit.quote);
    assert.equal(hit.chapter, "CHAPTER VI");
  }
});

test("长原文检索主动让出事件循环，取消后不采用片段，不阻塞WS处理", async () => {
  const { searchNovelFulltextAsync } =
    await import("../src/novel-play/fulltext.ts");
  const controller = new AbortController();
  let tick = false;
  const text = "原文内容：事实仍应定位。".repeat(1000);
  const long = {
    ...source,
    chunks: Array.from({ length: 60 }, (_, index) => ({
      index,
      text,
      chars: text.length,
      chapters: [],
    })),
  };
  const pending = searchNovelFulltextAsync(
    long,
    "事实",
    3,
    "author-planning",
    undefined,
    controller.signal,
  );
  setImmediate(() => {
    tick = true;
    controller.abort();
  });
  await assert.rejects(pending, /cancelled/);
  assert.equal(tick, true);
});

test("同一模型回执里先read再预填补查的查询不会发出；模型必须先消费真实原文再决定", async () => {
  let net = 0;
  const f = fixture(
    "direct",
    [
      { calls: [{ name: "web_research", args: { queries: ["public fact"] } }] },
      {
        calls: [
          { name: "web_open", args: { url: "https://source.test/a" } },
          {
            name: "web_research",
            args: { queries: ["precomputed dependent follow-up"] },
          },
        ],
      },
      { text: "保留未核实内容的合成回复。" },
    ],
    {
      webResearch: async (qs) => {
        net += qs.length;
        return qs.map((query) => ({
          query,
          results: [
            {
              title: "source",
              url: "https://source.test/a",
              snippet: "candidate",
            },
          ],
        }));
      },
      webOpen: async (url) => ({
        url,
        documentText: "原文证据，需先读取才能追查。",
      }),
    },
  );
  try {
    await f.engine.performTurn("核查公开细节");
    assert.equal(net, 1);
    const last = f.requests.filter((r) => r.model === "writer").at(-1)!;
    assert.match(JSON.stringify(last.context.messages), /research-deferred/);
    assert.match(JSON.stringify(last.context.messages), /原文证据/);
  } finally {
    f.cleanup();
  }
});

test("actual StageEngine accepts a plan declaring new questions before guarding subsequent reads", async () => {
  let reads = 0;
  const f = fixture("direct", [
    { calls: [{ name: "research_record", args: { action: "plan", question_id: "new_group", questions: [
      { id: "date", text: "公开记录日期", important: true },
      { id: "other", text: "另一个独立问题", important: true },
    ] } }] },
    { calls: [{ name: "web_research", args: { question_id: "date", queries: ["public date record"] } }] },
    { calls: [{ name: "web_open", args: { question_id: "other", url: "https://source.test/date" } }] },
    { calls: [{ name: "web_open", args: { question_id: "date", url: "https://source.test/date" } }] },
    { text: "依据当前问题授权读取的合成记录；其它问题不能借用该来源。" },
  ], {
    webResearch: async queries => queries.map(query => ({ query, results: [{ title: "public date record", url: "https://source.test/date", snippet: "candidate only" }] })),
    webOpen: async url => { reads++; return { url, documentText: "Synthetic public date record: 1901." }; },
  });
  try {
    await f.engine.performTurn("核查公开记录日期");
    const history = JSON.stringify(f.requests.filter(row => row.model === "writer").at(-1)!.context.messages);
    assert.match(history, /research-receipt/);
    assert.match(history, /source URL not authorized for this question/);
    assert.match(history, /Synthetic public date record/);
    assert.equal(reads, 1);
  } finally { f.cleanup(); }
});

test("new-question planning still rejects malformed questions without granting later URL reads", async () => {
  let reads = 0;
  const f = fixture("direct", [
    { calls: [{ name: "research_record", args: { action: "plan", question_id: "new_group", questions: [
      { id: "duplicate", text: "one" }, { id: "duplicate", text: "two" },
    ] } }] },
    { calls: [{ name: "web_open", args: { question_id: "duplicate", url: "https://unoffered.test/private" } }] },
    { text: "计划无效且来源未授权，没有核实该问题。" },
  ], { webResearch: async () => [], webOpen: async url => { reads++; return { url, documentText: "must not read" }; } });
  try {
    await f.engine.performTurn("核查公开记录");
    const history = JSON.stringify(f.requests.filter(row => row.model === "writer").at(-1)!.context.messages);
    assert.match(history, /invalid or duplicate question ids/);
    assert.equal(reads, 0);
  } finally { f.cleanup(); }
});

test("actual Stage rejects copied historical user speech outside the last eight entries before egress", async () => {
  let outbound = 0;
  const copied = "synthetic unpublished harbour appointment";
  const f = fixture("direct", [
    { calls: [{ name: "web_research", args: { queries: [copied] } }] },
    { text: "没有把私人对话发送到外部。" },
  ], { webResearch: async queries => { outbound++; return queries.map(query => ({ query, results: [] })); } });
  try {
    f.sm.appendMessage({ role: "user", content: [{ type: "text", text: "Private prior dialogue: " + copied }], timestamp: Date.now() } as never);
    for (let i=0;i<12;i++) f.sm.appendCustomEntry("synthetic-padding", { index: i });
    await f.engine.performTurn("继续合成故事，不外发私人对话。");
    assert.equal(outbound, 0);
    assert.ok(f.requests.some(r => JSON.stringify(r.context).includes("复制的私人上下文")));
  } finally { f.cleanup(); }
});


test("actual Stage egress blocks fresh contact/credential queries even with an injected provider",async()=>{
 let outbound=0;
 const f=fixture("direct",[
  {calls:[{name:"web_research",args:{queries:["2125550100", "sk-proj-1234567890ABCDEF"]}}]},
  {text:"没有外发联系方式或凭据。"},
 ],{webResearch:async queries=>{outbound++;return queries.map(query=>({query,results:[]}));}});
 try{await f.engine.performTurn("合成私人电话2125550100，请不要外发。");assert.equal(outbound,0);
  assert.ok(f.requests.some(r=>JSON.stringify(r.context).includes("凭据或联系方式")));
 }finally{f.cleanup();}
});

test("current explicit public query is not classified as copied historical private speech",async()=>{
 let outbound=0;const query="IANA example domains";
 const f=fixture("direct",[{calls:[{name:"web_research",args:{queries:[query]}}]},{text:"公开核查未找到原文。"}],
  {webResearch:async queries=>{outbound++;return queries.map(query=>({query,results:[]}));}});
 try{await f.engine.performTurn("请联网搜索 "+query);assert.equal(outbound,1);}finally{f.cleanup();}
});

test("actual Stage rechecks privacy on candidate URL before invoking the page provider",async()=>{
 let opened=0;const url="https://public.test/SyntheticPrivateActor/record";
 const f=fixture("direct",[
  {calls:[{name:"web_research",args:{queries:["public lighthouse history"]}}]},
  {calls:[{name:"web_open",args:{url,focus:"history"}}]},
  {text:"受保护身份没有外发。"},
 ],{webResearch:async queries=>queries.map(query=>({query,results:[{title:"history",url,snippet:"candidate only"}]})),
  webOpen:async requested=>{opened++;return{url:requested,documentText:"synthetic page"};}});
 try{await f.engine.performTurn("核查公开灯塔历史。");assert.equal(opened,0);
  assert.ok(f.requests.some(r=>JSON.stringify(r.context).includes("受保护身份或角色名")));
 }finally{f.cleanup();}
});


test("a prior public URL citation does not prevent explicit source reading after cache loss",async()=>{
 for(const shown of ["https://www.official.test/reference","www.official.test/reference","official.test/reference"]){
  let opened=0;const url="https://www.official.test/reference";
  const f=fixture("direct",[{calls:[{name:"web_open",args:{url}}]},{text:"来自实际原文的公开核查。"}],{
   webResearch:async()=>[],webOpen:async requested=>{opened++;return{url:requested,documentText:"Public original reference."};}});
  try{f.sm.appendMessage({role:"assistant",content:[{type:"text",text:"公开参考："+shown}],details:{rpNarrative:"公开参考："+shown},timestamp:Date.now()}as never);
   await f.engine.performTurn("请联网重读 "+url);assert.equal(opened,1,shown);
  }finally{f.cleanup();}
 }
});

test("source reading still rejects independently copied private speech encoded in a candidate URL",async()=>{
 let opened=0;const copied="synthetic unpublished harbour appointment",url="https://public.test/"+encodeURIComponent(copied);
 const f=fixture("direct",[{calls:[{name:"web_research",args:{queries:["public lighthouse facts"]}}]},
  {calls:[{name:"web_open",args:{url}}]},{text:"没有外发私人原话。"}],{
  webResearch:async queries=>queries.map(query=>({query,results:[{title:"candidate",url,snippet:"public"}]})),
  webOpen:async requested=>{opened++;return{url:requested,documentText:"not reached"};}});
 try{f.sm.appendMessage({role:"user",content:"Private speech: "+copied,timestamp:Date.now()}as never);
  await f.engine.performTurn("仅核查公开灯塔资料。");assert.equal(opened,0);
 }finally{f.cleanup();}
});


test("original greeting, edited custom text, legacy assistant text and author-format fields are private egress sources",async()=>{
 for(const kind of ["greeting","custom","legacy","author-format"]as const){
  const copied="synthetic confidential lantern appointment",rawCard={data:{name:"SyntheticPrivateActor",description:"test only",first_mes:kind==="greeting"?copied:"safe greeting"}};
  let outbound=0;const f=fixture("direct",[{calls:[{name:"web_research",args:{queries:[copied]}}]},{text:"私人素材未外发。"}],{
   rawCard,webResearch:async queries=>{outbound++;return queries.map(query=>({query,results:[]}));}});
  try{if(kind==="custom")f.sm.appendCustomMessageEntry("rp-edited-reply",copied,true);
   else if(kind!=="greeting")f.sm.appendMessage({role:"assistant",content:[{type:"text",text:kind==="legacy"?copied:"safe canonical text"}],...(kind==="author-format"?{details:{rpNarrative:"safe canonical text",rpAuthorDraft:"<format>"+copied+"</format>"}}:{}),timestamp:Date.now()}as never);
   await f.engine.performTurn("继续普通合成故事。");assert.equal(outbound,0,kind);
  }finally{f.cleanup();}
 }
});


test("malformed explicit source URL cannot break ordinary author delivery",async()=>{
 let opened=0;const f=fixture("direct",[{text:"普通正文仍然交付。"}],{webResearch:async()=>[],webOpen:async url=>{opened++;return{url};}});
 try{await f.engine.performTurn("继续剧情，附带错误网址 https://[broken");assert.equal(opened,0);
  assert.equal(f.sm.getBranch().filter((e:any)=>e.message?.role==="assistant").length,1);
 }finally{f.cleanup();}
});


test("schema-optional gaps are accepted but missing/incorrect evidence still becomes an unresolved claim",()=>{
 const s=createResearchSession("synthetic-scope","synthetic task",()=>true);
 const result=s.record({action:"finish",claims:[{questionId:"task",kind:"external",text:"Unverified external claim",verdict:"supported",evidenceIds:["e:invented"]}]});
 assert.equal(result.isError,undefined);const row=JSON.parse(result.text);
 assert.equal(row.claims[0].verdict,"unknown");assert.ok(row.gaps.length);assert.equal(row.stop,"gaps");
 assert.equal(s.record({action:"finish",claims:[],gaps:null}).isError,true);
});


test("existing director expert sources receive ancestor-validated actual cached page, not an old author paraphrase",async()=>{
 const url="https://official.test/reference";let opens=0;
 const f=fixture("direct",[{calls:[{name:"web_open",args:{url}}]},{text:"Old author paraphrase without an exact quote."}],{
  webResearch:async()=>[],webOpen:async requested=>{opens++;return{url:requested,documentText:"ACTUAL HOST READ: the reserved colour is cyan."};}});
 try{await f.engine.performTurn("请联网读取 "+url);
  f.responses.push(...director("The source says cyan; original fictional world remains unchanged."));
  await f.engine.performTurn("请核对同一官方原文 "+url,{generationMode:"director"});
  const review=f.requests.find(r=>r.model==="directorReviewFacts")!;
  assert.match(JSON.stringify(review.context),/ACTUAL HOST READ/);assert.match(JSON.stringify(review.context),/external-untrusted/);
  assert.match(JSON.stringify(review.context),/sourceRevision/);assert.equal(opens,1);
 }finally{f.cleanup();}
});


test("known ancestor-read URL remains reusable when an earlier public query happens to overlap its path",async()=>{
 const url="https://official.test/example-domains";let opens=0;
 const f=fixture("direct",[{calls:[{name:"web_open",args:{url}}]},{text:"Official example domains evidence."}],{
  webResearch:async()=>[],webOpen:async requested=>{opens++;return{url:requested,documentText:"ACTUAL READ: the example domains are reserved."};}});
 try{await f.engine.performTurn("请查 example domains 原文 "+url);
  f.responses.push(...director("Only the actual source supports the statement."));
  await f.engine.performTurn("请核对同一原文 "+url,{generationMode:"director"});
  assert.equal(opens,1);assert.match(JSON.stringify(f.requests.find(r=>r.model==="directorReviewFacts")!.context),/ACTUAL READ/);
 }finally{f.cleanup();}
});
