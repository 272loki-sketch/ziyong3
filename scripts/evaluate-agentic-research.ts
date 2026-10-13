import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const { StageEngine } = await import(
  process.env.LIYUAN_RESEARCH_VARIANT_ROOT
    ? process.env.LIYUAN_RESEARCH_VARIANT_ROOT + "/src/stage/engine.ts"
    : new URL("../src/stage/engine.ts", import.meta.url).href
);
import { researchEngineFixture } from "../test/support/research-engine-fixture.ts";
import { buildNovelPackage } from "../src/novel-play/canon.ts";
import { novelNodeId } from "../src/novel-play/source.ts";
import { saveNovelPackage } from "../src/novel-play/store.ts";
import {
  modelFor,
  authFor,
  stream,
  sideRefs,
  findTestModel,
  redactEvaluation,
} from "./research-test-model.ts";
const turnEvents: any[] = [];
const transcript: any[] = [];
const started = Date.now();
class RealEngine extends StageEngine {
  constructor(deps: any) {
    super({
      ...deps,
      getModel: () => modelFor("writer"),
      findModel: findTestModel,
      getAuth: authFor,
      streamFn: (m: any, ctx: any, opts: any) => {
        const row: any = {
          model: m.id,
          at: Date.now() - started,
          tools: ctx.tools?.map((t: any) => t.name),
          messages: ctx.messages,
          systemPromptChars: ctx.systemPrompt.length,
        };
        transcript.push(row);
        const actual = stream(m, ctx, {
          ...opts,
          maxTokens: Math.min(opts.maxTokens ?? 2048, 3072),
          maxRetries: 0,
          timeoutMs: 180000,
        });
        return {
          async *[Symbol.asyncIterator]() {
            for await (const ev of actual) {
              if (ev.type === "done")
                row.result = {
                  ...ev.message,
                  content: ev.message.content.filter(
                    (p: any) => p.type !== "thinking",
                  ),
                };
              else if (ev.type === "error")
                row.result = {
                  stopReason: ev.error?.stopReason,
                  content: [],
                  error: "provider request failed",
                };
              yield ev;
            }
          },
          async result() {
            const r = await actual.result();
            row.result = {
              ...r,
              content: r.content.filter((p: any) => p.type !== "thinking"),
              errorMessage: r.errorMessage
                ? "provider request failed"
                : undefined,
            };
            return r;
          },
        };
      },
    });
  }
}
const mode = process.argv[2] ?? "direct";
const scenario = process.argv[3] ?? "canon";
if (
  !["direct", "director"].includes(mode) ||
  !["ordinary", "canon", "conflict", "followup", "public", "austen"].includes(
    scenario,
  )
)
  throw Error("unknown test case");
const out = process.env.LIYUAN_RESEARCH_EVAL_OUTPUT_DIR;
if (!out) throw Error("Set an explicit private output directory");
mkdirSync(out, { recursive: true, mode: 0o700 });
let source: any, pkg: any, cwd: string | undefined, rawCard: any, input: string;
let searchCount = 0,
  readCount = 0;
if (scenario === "canon") {
  cwd = mkdtempSync(join(tmpdir(), "liyuan-real-canon-"));
  const a =
    "第一章 春桥\n林舟佩戴青色围巾。叶澄此时不知道密信内容。春桥相遇，两人约定次日再来。";
  const b =
    "第二章 秋信\n叶澄收到林舟亲手递来的密信，首次得知灯塔信号的含义。原著在秋日才揭晓此事。";
  const c = "第三章 私密\n隐藏口令是紫花，角色目前不可见。";
  const text = [a, b, c].join("\n\n");
  source = {
    version: 1,
    docId: "synthetic-golden",
    title: "授权合成作品：春桥秋信",
    fingerprint: createHash("sha256").update(text).digest("hex"),
    chunkChars: 10000,
    chunks: [
      {
        index: 0,
        chars: text.length,
        chapters: ["第一章 春桥", "第二章 秋信", "第三章 私密"],
        text,
      },
    ],
  };
  const quote1 = "春桥相遇，两人约定次日再来。",
    quote2 = "叶澄收到林舟亲手递来的密信，首次得知灯塔信号的含义。",
    quote3 = "隐藏口令是紫花，角色目前不可见。";
  const ref = (quote: string) => ({
    chunkIndex: 0,
    start: text.indexOf(quote),
    end: text.indexOf(quote) + quote.length,
    quote,
  });
  const r1 = ref(quote1),
    r2 = ref(quote2),
    r3 = ref(quote3);
  pkg = buildNovelPackage(
    source,
    [{ id: "v1", order: 0, title: "第一卷" }],
    [
      {
        id: novelNodeId(source, r1, "spring"),
        key: "spring",
        stageId: "v1",
        order: 0,
        title: "春桥相遇",
        summary: "两人约定次日再来",
        visibility: "public",
        dependsOn: [],
        sourceRefs: [r1],
      },
      {
        id: novelNodeId(source, r2, "autumn"),
        key: "autumn",
        stageId: "v1",
        order: 1,
        title: "秋日知信",
        summary: "原著秋日知情",
        visibility: "public",
        dependsOn: [],
        sourceRefs: [r2],
      },
      {
        id: novelNodeId(source, r3, "secret"),
        key: "secret",
        stageId: "v1",
        order: 2,
        title: "秘密",
        summary: "秘密",
        visibility: "secret",
        dependsOn: [],
        sourceRefs: [r3],
      },
    ],
  );
  saveNovelPackage(cwd, source, pkg);
  rawCard = {
    data: {
      name: "合成林舟",
      description: "原创测试角色，所有资料仅供隔离测试。",
      personality: "温和",
      first_mes: "春桥相遇。",
      extensions: {
        liyuanNovelPlay: {
          version: 1,
          docId: source.docId,
          revision: pkg.revision,
          startNodeId: pkg.nodes[0].id,
          position: "after",
        },
      },
    },
  };
  input =
    "只做原著核查，暂不续写新事件：林舟初遇时围巾是什么颜色、在哪一章？叶澄第一章是否已经知道密信？作者另需了解原著未来哪章首次得知、通过何种渠道。事件索引可能没覆盖衣物细节，请优先用本地完整原文与精确引用，作者未来知识不能赋予当前角色；缺证据就注明。回答不超过220字。";
} else if (scenario === "austen") {
  cwd = mkdtempSync(join(tmpdir(), "liyuan-real-austen-"));
  const whole = readFileSync(
    process.env.LIYUAN_RESEARCH_PUBLIC_AUSTEN_FILE ?? "",
    "utf8",
  );
  const headings = [...whole.matchAll(/^\s*CHAPTER\s+([IVXLCDM]+)\.\s*$/gm)];
  const chapter = (roman: string) => {
    const i = headings.findIndex((m) => m[1] === roman);
    if (i < 0) throw Error("source chapter missing");
    return whole.slice(headings[i].index!, headings[i + 1].index!);
  };
  const chunks = [chapter("III"), chapter("VI")].map((text, index) => ({
    index,
    chars: text.length,
    chapters: ["CHAPTER " + (index === 0 ? "III." : "VI.")],
    text,
  }));
  source = {
    version: 1,
    docId: "austen-pg1342-excerpts",
    title: "Pride and Prejudice · Austen · PG1342 · Chapters III, VI excerpts",
    fingerprint: createHash("sha256")
      .update(chunks.map((c) => c.text).join("\n"))
      .digest("hex"),
    chunkChars: 20000,
    chunks,
  };
  const ref = (index: number, needle: string) => {
    const text = chunks[index].text,
      start = text.indexOf(needle);
    if (start < 0) throw Error("original quote missing");
    return {
      chunkIndex: index,
      start,
      end: start + needle.length,
      quote: needle,
    };
  };
  const r1 = ref(0, chunks[0].text.slice(-220).trim()),
    r2 = ref(1, "this she was perfectly unaware");
  pkg = buildNovelPackage(
    source,
    [{ id: "s", order: 0, title: "Original Chapters III–VI" }],
    [
      {
        id: novelNodeId(source, r1, "ball"),
        key: "ball",
        stageId: "s",
        order: 0,
        title: "Meryton assembly",
        summary:
          "Darcy meets the Bennets at the ball; indexed name only, no interpreted motive.",
        visibility: "public",
        dependsOn: [],
        sourceRefs: [r1],
      },
      {
        id: novelNodeId(source, r2, "unaware"),
        key: "unaware",
        stageId: "s",
        order: 1,
        title: "Elizabeth remains unaware",
        summary: "Later original narrator explicitly says she is unaware.",
        visibility: "public",
        dependsOn: [],
        sourceRefs: [r2],
      },
    ],
  );
  saveNovelPackage(cwd, source, pkg);
  rawCard = {
    data: {
      name: "Public literature test",
      description:
        "Public-domain Austen source excerpts. Current scene at the Chapter III ball, not later events.",
      personality: "Original characters, source evidence preferred.",
      first_mes: "At the Meryton ball.",
      extensions: {
        liyuanNovelPlay: {
          version: 1,
          docId: source.docId,
          revision: pkg.revision,
          startNodeId: pkg.nodes[0].id,
          position: "after",
        },
      },
    },
  };
  input =
    "研究《Pride and Prejudice》英语原文，不写新剧情：1）Darcy 在第三章为何不与 Elizabeth 跳舞，他的原话是什么？2）作者规划第六章：Darcy 对她的哪些特征改变看法？Elizabeth 当时是否知道？请用本地未进事件索引的原文查证，准确标明章节与引用，不把第六章作者知识赋予第三章角色。答案不超过220字。";
} else if (scenario === "public") {
  input =
    "请核查 IANA 的保留示例域名是否包含 example.com、example.org。读取 https://www.iana.org/help/example-domains 的原文，最多80字，不要把搜索摘要当原文。";
} else if (scenario === "ordinary") {
  input =
    "请继续虚构的普通情感互动：两人坐在窗边喝茶，写80字，今天不讨论外部事实。";
} else {
  input =
    "核查公开的合成历史问题：River Lantern 试验究竟始于1900还是1901？不改变原创世界的两个月亮设定。请认真读取来源，发现冲突时寻找档案；缺证据保留不确定。只给简短研究结果。";
}
const f = researchEngineFixture(mode as any, [], {
  Engine: RealEngine,
  cwd,
  rawCard,
  events: {
    onAuthorReady: (r: any) =>
      turnEvents.push({ kind: "ready", at: Date.now() - started }),
    onTurnEnd: (r: any) =>
      turnEvents.push({ kind: "end", at: Date.now() - started, ...r }),
  },
  worldText: "这个原创世界有两个月亮，外部资料不能覆盖。",
  webResearch: async (qs) => {
    searchCount += qs.length;
    if (scenario === "public") {
      const { webResearchBatch } = await import("../server/web-research.ts");
      return webResearchBatch(qs, 3, {
        card: { name: "SyntheticPublicTest" } as any,
        signal: AbortSignal.timeout(20000),
      });
    }
    return qs.map((query) => ({
      query,
      results:
        scenario === "followup" && readCount === 0
          ? [
              {
                title: "River Lantern summary (secondary)",
                url: "https://synthetic-source.test/summary",
                snippet:
                  "1900 per later encyclopedia; original register not yet checked",
              },
            ]
          : [
              {
                title: "River Lantern summary (secondary)",
                url: "https://synthetic-source.test/summary",
                snippet: "1900 according to later encyclopedia",
              },
              {
                title: "River Lantern original archive register",
                url: "https://synthetic-source.test/dispute",
                snippet:
                  "Official Lantern Register, proposed date vs actual first run",
              },
            ],
    }));
  },
  webOpen: async (url) => {
    readCount++;
    if (scenario === "public") {
      const { readPublicWebDocument } =
        await import("../server/web-source-reader.ts");
      return {
        url,
        documentText:
          (await readPublicWebDocument(url, AbortSignal.timeout(10000))) ??
          undefined,
      };
    }
    return {
      url,
      documentText: url.includes("summary")
        ? "Secondary account claims 1900. No primary quote is given. An editorial note says the Original Lantern Register contradicts this date; the exact entry must be checked."
        : "Original synthetic archival log: River Lantern first experimental run was 2 March 1901. The 1900 entry was a preliminary proposal, not an experiment.",
    };
  },
});
const testConfig = JSON.parse(
  readFileSync(join(f.cwd, "liyuan.config.json"), "utf8"),
);
testConfig.stepModels = { ...sideRefs };
testConfig.generationTimeoutMinutes = 5;
writeFileSync(join(f.cwd, "liyuan.config.json"), JSON.stringify(testConfig));
try {
  const start = Date.now();
  let readyMs: number | undefined;
  // Read-only diagnostics are synthetic. No journal in production.
  const result = await f.engine.performTurn(input);
  const branch = f.sm.getBranch();
  const saved: any = branch
    .filter((e: any) => e.message?.role === "assistant")
    .at(-1);
  const output = {
    mode,
    scenario,
    ms: Date.now() - start,
    searchCount,
    readCount,
    result,
    narrative: saved?.message?.details?.rpNarrative,
    authorDraft: saved?.message?.details?.rpAuthorDraft,
    workflow: saved?.message?.details?.rpGenerationWorkflow,
    turnEvents,
    calls: transcript.map((row) => ({
      model: row.model,
      at: row.at,
      tools: row.result?.content?.filter((x: any) => x.type === "toolCall"),
      stop: row.result?.stopReason,
      usage: row.result?.usage,
    })),
    transcript,
    billedCost: null,
  };
  writeFileSync(
    join(
      out,
      (process.env.LIYUAN_RESEARCH_EVAL_LABEL ?? "real") +
        "-" +
        mode +
        "-" +
        scenario +
        ".json",
    ),
    JSON.stringify(redactEvaluation(output), null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      redactEvaluation({
        mode,
        scenario,
        ms: output.ms,
        searchCount,
        readCount,
        aborted: turnEvents.find((e) => e.kind === "end")?.aborted,
        error: turnEvents.find((e) => e.kind === "end")?.error,
        authorDraft: output.authorDraft,
        workflow: output.workflow,
        calls: output.calls.map((c) => ({
          model: c.model,
          tools: c.tools?.map((t: any) => t.name),
          stop: c.stop,
          usage: c.usage,
        })),
      }),
    ),
  );
} finally {
  f.cleanup();
}
