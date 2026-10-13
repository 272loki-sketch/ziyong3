import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { once } from "node:events";

import { webResearchTool, webOpenTool, wantsManualWebResearch } from "../src/tools/web-research.ts";
import { unifiedStageTools } from "../src/tools/adapters/stage.ts";
import type { UnifiedStageDeps } from "../src/tools/adapters/stage.ts";
import {
	hostUsesWebResearchProxy,
	fallbackSearchLocale,
	boundedFetchText,
	tunnel,
	isSearchChallenge,
	parseBing,
	parseDuckDuckGo,
	rankWebResearchResults,
	resolveWebResearchProxy,
	sanitizeWebResearchQuery,
	containsPrivateSearchMaterial,
} from "../server/web-research.ts";

test("联网查证工具：最多三个查询，部分失败保留并格式化", async () => {
	let received: string[] = [];
	const result = await webResearchTool.run({
		queries: ["甲 查询", "乙 查询", "甲 查询", "丙 查询", "丁 查询"], max_results_per_query: 9,
	}, {
		webResearch: async (queries, maxResults) => {
			received = queries;
			assert.equal(maxResults, 5);
			return [
				{ query: queries[0], results: [{ title: "标题", url: "https://example.com", snippet: "摘要" }] },
				{ query: queries[1], error: "timeout" },
				{ query: queries[2], rejected: "私人信息" },
			];
		},
	}, { surface: "stage", language: "中文" });
	assert.deepEqual(received, ["甲 查询", "乙 查询", "丙 查询"]);
	assert.ok(result.text.includes("https://example.com"));
	assert.ok(result.text.includes("timeout"));
	assert.ok(result.text.includes("私人信息"));
});

test("联网结果：识别人机验证并可解析 Bing 兜底", () => {
	assert.equal(isSearchChallenge("Please complete the following challenge to confirm this search was made by a human"), true);
	const html = '<ol><li class="b_algo"><h2><a href="https://example.com/story">校园图书馆活动</a></h2><div><p class="b_lineclamp2">旧书募集与读书会资料</p></div></li></ol>';
	assert.deepEqual(parseBing(html), [{ title: "校园图书馆活动", url: "https://example.com/story", snippet: "旧书募集与读书会资料" }]);
});

test("联网查证模式：manual 只接受明确联网意图", () => {
	assert.equal(wantsManualWebResearch("请联网搜索一下明治时期的资料"), true);
	assert.equal(wantsManualWebResearch("帮我上网搜一下明治资料"), true);
	assert.equal(wantsManualWebResearch("请百度一下明治资料"), true);
	assert.equal(wantsManualWebResearch("查一下网上的公开资料"), true);
	assert.equal(wantsManualWebResearch("继续剧情，去图书馆查资料"), false);
});

test("联网查询最终闸门剔除用户栏姓名并保留剧情主题", () => {
	assert.equal(sanitizeWebResearchQuery("测试玩家 高中篮球社 放学后训练活动", "测试玩家"), "高中篮球社 放学后训练活动");
	assert.equal(sanitizeWebResearchQuery("图书馆 朱.耀良 读书会", "朱.耀良"), "图书馆 读书会");
});

test("联网代理：专用变量优先、direct 关闭、NO_PROXY 生效", () => {
	assert.equal(resolveWebResearchProxy({ LIYUAN_WEB_RESEARCH_PROXY: "http://127.0.0.1:9000", HTTPS_PROXY: "http://x:1" } as never)?.port, "9000");
	assert.equal(resolveWebResearchProxy({ LIYUAN_WEB_RESEARCH_PROXY: "direct" } as never), null);
	const proxy = new URL("http://127.0.0.1:7890");
	assert.equal(hostUsesWebResearchProxy("localhost", proxy, { NO_PROXY: "localhost,.example.com" } as never), false);
	assert.equal(hostUsesWebResearchProxy("api.example.com", proxy, { NO_PROXY: "localhost,.example.com" } as never), false);
	assert.equal(hostUsesWebResearchProxy("duckduckgo.com", proxy, { NO_PROXY: "localhost" } as never), true);
});

test("联网结果：DuckDuckGo 解析、URL 去重和相关性排名", () => {
	const html = '<a class="result__a" href="https://example.com/a">明治 京都</a><a class="result__snippet">町屋取暖资料</a>';
	assert.equal(parseDuckDuckGo(html).length, 1);
	const ranked = rankWebResearchResults("明治 京都", [
		{ title: "无关", url: "https://x.example", snippet: "" },
		{ title: "明治 京都", url: "https://example.com/a#part", snippet: "资料" },
		{ title: "重复", url: "https://example.com/a", snippet: "明治" },
	]);
	assert.equal(ranked.length, 1);
	assert.ok(ranked[0].title.includes("明治"));
});

test("网页读取工具：只显示带来源的内容，不把缺失原文冒充成功", async () => {
	const context = { surface: "stage" as const, language: "中文" };
	const result = await webOpenTool.run({url:"https://example.org/chapter",focus:"关键剧情"}, {
		webOpen: async (url, focus) => {
			assert.equal(url,"https://example.org/chapter");
			assert.equal(focus,"关键剧情");
			return {url,excerpt:"第二学期末人物得知真相"};
		},
	}, context);
	assert.ok(result.text.includes("第二学期末人物得知真相"));
	assert.ok(result.text.includes("需核实"));
	const missing = await webOpenTool.run({url:"https://example.org/chapter"}, {
		webOpen: async url => ({url,rejected:"来源不是本拍搜索结果"}),
	}, context);
	assert.ok(missing.text.includes("未读取"));
});

test("研究工具按宿主能力投影，不无条件出现在普通故事中", () => {
	const empty = unifiedStageTools("中文", {} as UnifiedStageDeps).map(tool=>tool.name);
	assert.equal(empty.includes("web_research"), false);
	assert.equal(empty.includes("web_open"), false);
	assert.equal(empty.includes("canon_research"), false);
	const bound = unifiedStageTools("中文", {
		webResearch: async ()=>[],
		webOpen: async (url:string)=>({url}),
		canonResearch: async ()=>[],
	} as UnifiedStageDeps).map(tool=>tool.name);
	assert.equal(bound.includes("web_research"), true);
	assert.equal(bound.includes("web_open"), true);
	assert.equal(bound.includes("canon_research"), true);
});

test("Bing fallback matches original-language searches", () => {
	assert.deepEqual(fallbackSearchLocale("ようこそ実力至上主義の教室へ 坂柳"), { language: "ja", market: "ja-JP", country: "JP" });
	assert.deepEqual(fallbackSearchLocale("明治时期的京都"), { language: "zh-Hans", market: "zh-CN", country: "CN" });
	assert.deepEqual(fallbackSearchLocale("English history of London"), { language: "en", market: "en-US", country: "US" });
});

test("search provider responses are read with a strict size budget", async () => {
	const normal = await boundedFetchText(new Response("原著篇章资料"));
	assert.equal(normal,"原著篇章资料");
	await assert.rejects(() => boundedFetchText(new Response("x",{headers:{"content-length":"1500001"}})), /大小限制/);
	const huge = new Response(new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(1_500_001));
			controller.close();
		}
	}),{headers:{"content-type":"text/html"}});
	await assert.rejects(() => boundedFetchText(huge), /大小限制/);
});

test("outbound searches reject contact details and secret-like keys without web access", () => {
	for (const query of ["jane@example.org", "Bearer abcdefghijklmnopqrst", "api_key=supersecret", "sk-proj-1234567890ABCDEF"]) {
		assert.equal(containsPrivateSearchMaterial(query), true, query);
	}
	assert.equal(containsPrivateSearchMaterial("明治京都住宅历史"), false);
	assert.equal(containsPrivateSearchMaterial("坂柳有栖 第一学年剧情"), false);
});

test("source proxy tunnel sends the vetted public IP, never proxy-resolves the page hostname", async () => {
	let authority = "";
	const server = net.createServer(socket => socket.once("data", chunk => {
		authority = chunk.toString("utf8").split("\r\n")[0];
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	}));
	server.listen(0, "127.0.0.1");
	await once(server,"listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test TCP port unavailable");
	try {
		await assert.rejects(tunnel(new URL("https://example.org/chapter"),
			new URL("http://127.0.0.1:" + address.port), AbortSignal.timeout(2000), "1.1.1.1"), /CONNECT 失败/);
		assert.equal(authority,"CONNECT 1.1.1.1:443 HTTP/1.1");
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

test("Bing wrapped links resolve to the original URL and tracking duplicates collapse",async()=>{
	const {canonicalSearchUrl}=await import("../server/web-research.ts");
	const original="https://archive.example/chapter?utm_source=bing&volume=2#position";
	const wrapped="https://www.bing.com/ck/a?u=a1"+Buffer.from(original).toString("base64url");
	assert.equal(canonicalSearchUrl(wrapped),"https://archive.example/chapter?volume=2");
	assert.equal(canonicalSearchUrl("javascript:alert(1)"),null);assert.equal(canonicalSearchUrl("https://a:private@example.org/"),null);
	const ranked=rankWebResearchResults("chapter",[{title:"chapter",url:wrapped,snippet:"chapter"},{title:"chapter",url:"https://archive.example/chapter?volume=2",snippet:"chapter"}],5);assert.equal(ranked.length,1);
});
test("declared oversized fetch payload is canceled, not left downloading in the background",async()=>{
	let canceled=false;const response=new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{"content-length":"1500001"}});
	await assert.rejects(boundedFetchText(response),/大小限制/);assert.equal(canceled,true);
	for(const query of [encodeURIComponent("sk-proj-1234567890ABCDEF"),"sk-\u200bproj-1234567890ABCDEF"])assert.equal(containsPrivateSearchMaterial(query),true);
});
test("normal search-engine locale redirects are bounded while arbitrary/private redirects are rejected",async()=>{
	const{trustedSearchRedirect}=await import("../server/web-research.ts");const from=new URL("https://www.bing.com/search?q=public");
	assert.equal(trustedSearchRedirect(from,"https://cn.bing.com/search?q=public",2)?.hostname,"cn.bing.com");
	for(const value of ["https://127.0.0.1/","https://evil.example/search","http://cn.bing.com/","https://cn.bing.com:8443/","https://user:secret@cn.bing.com/"])assert.equal(trustedSearchRedirect(from,value,2),null);
	assert.equal(trustedSearchRedirect(from,"https://cn.bing.com/",0),null);
});
test("search markup supports attribute order, quotes, nesting and Unicode without interpreting active content",()=>{
	const duck='<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fprimary.test%2Fchapter" class="result__a"><span>京都 明治</span></a><div class="result__snippet">原文 <b>明治</b> 京都。</div>';
	assert.deepEqual(parseDuckDuckGo(duck),[{title:"京都 明治",url:"https://primary.test/chapter",snippet:"原文 明治 京都。"}]);
	const bing="<head><script>fake b_algo results</script></head><li class='b_algo'><h2>\n<a href='https://primary.test/original?x=1&amp;y=2'>İstanbul <b>history</b></a>\n</h2><p>Original history detail.</p></li>";
	assert.deepEqual(parseBing(bing),[{title:"İstanbul history",url:"https://primary.test/original?x=1&y=2",snippet:"Original history detail."}]);
});
test("malformed search HTML stays bounded and oversized links are never silently rewritten",async()=>{
	const{performance}=await import("node:perf_hooks");const at=performance.now();
	parseDuckDuckGo('<a class="result__a" href="https://example.org/">'.repeat(25000));
	parseBing('<li class="b_algo"><h2><a href="https://example.org/">'.repeat(25000));
	assert.ok(performance.now()-at<3000,"bounded response bytes do not justify quadratic parsing");
	const url="https://primary.test/"+"x".repeat(2100);const rows=parseBing(`<li class="b_algo"><h2><a href="${url}">public history</a></h2><p>public history</p></li>`);assert.equal(rows[0].url,url);assert.deepEqual(rankWebResearchResults("public history",rows),[]);
});
test("result identity/source order is retained and only eight discovery candidates are parsed",()=>{
	const html=Array.from({length:12},(_,i)=>`<li class="b_algo"><h2><a href="https://primary.test/${i}">public history ${i}</a></h2><p>public history ${i}</p></li>`).join("");
	const rows=parseBing(html);assert.equal(rows.length,8);assert.equal(rows[0].url,"https://primary.test/0");assert.equal(rows.at(-1)?.url,"https://primary.test/7");
});
test("Bing preserves query-language markets without forcing the unrelated international-view selector",async()=>{
 const{bingSearchUrl}=await import("../server/web-research.ts");
 for(const[query,market]of [["Kyoto history","en-US"],["京都 历史","zh-CN"],["京都の歴史","ja-JP"]]){const url=bingSearchUrl(query);assert.equal(url.hostname,"www.bing.com");assert.equal(url.searchParams.has("ensearch"),false);assert.equal(url.searchParams.get("mkt"),market);assert.equal(url.searchParams.get("q"),query);}
});
test("overlapping CJK name fragments do not fake independent volume/event coverage",()=>{
 const rows=[{title:"坂柳有栖 人物百科",url:"https://secondary.test/biography",snippet:"坂柳有栖的相关介绍"},{title:"坂柳有栖 第十卷事件",url:"https://primary.test/volume10",snippet:"坂柳有栖在第十卷的事件证据"}];
 assert.deepEqual(rankWebResearchResults("坂柳有栖 第十卷",rows,3).map(row=>row.url),["https://primary.test/volume10"]);
 assert.deepEqual(rankWebResearchResults("Kyoto Meiji",[{title:"Kyoto travel",url:"https://primary.test/kyoto",snippet:"Kyoto tourist information"}],3),[]);
 assert.deepEqual(rankWebResearchResults("京都の歴史 明治",[{title:"京都 観光",url:"https://primary.test/travel",snippet:"京都の風景、お寺や神社"}],3),[]);
});
test("inline highlighting preserves compound CJK names instead of inserting fictional spaces",()=>{
 const html='<li class="b_algo"><h2><a href="https://primary.test/volume10"><b>坂柳</b>有栖 第十卷</a></h2><p>第十卷事件原文</p></li>';
 const rows=parseBing(html);assert.equal(rows[0].title,"坂柳有栖 第十卷");assert.equal(rankWebResearchResults("坂柳有栖 第十卷",rows).length,1);
});

test('unconfigured research does not silently require an unrelated localhost proxy; explicit proxy is respected',async()=>{
 const {resolveWebResearchProxy}=await import('../server/web-research.ts');
 assert.equal(resolveWebResearchProxy({} as NodeJS.ProcessEnv),null);
 assert.equal(resolveWebResearchProxy({LIYUAN_WEB_RESEARCH_PROXY:'http://127.0.0.1:7890'} as NodeJS.ProcessEnv)!.port,'7890');
 assert.throws(()=>resolveWebResearchProxy({LIYUAN_WEB_RESEARCH_PROXY:'socks5://proxy.test:1080'} as NodeJS.ProcessEnv),/不支持/);
});

test("Latin whole-token relevance prevents grammar pages from matching astronomy queries via substrings", () => {
  const unrelated = [
    { title: "Do vs. Does: How to Use Do and Does in English", url: "https://grammar.test/do-does", snippet: "Master the grammar rules for do and does. Learn the base verb rule, explore do/does vs. am/is/are, avoid common errors." },
    { title: "DOES | English meaning", url: "https://dictionary.test/does", snippet: "DOES definition: he/she/it form of do. Learn more." },
  ];
  assert.deepEqual(rankWebResearchResults("does Mercury or Venus have moons", unrelated), []);
  const original = { title: "Mercury and Venus: Moons", url: "https://primary.test/moons", snippet: "Mercury and Venus have no moons." };
  assert.deepEqual(rankWebResearchResults("does Mercury or Venus have moons", [...unrelated, original]), [original]);
  assert.deepEqual(rankWebResearchResults("NASA Mars", [{ title: "NASA scientist Marsden", url: "https://unrelated.test/person", snippet: "A biography, not planetary satellites." }]), []);
});


test("lexical coverage does not reorder a primary source below a keyword-heavy derivative", () => {
 const rows = [
  { title: "Example Domains - Internet Assigned Numbers Authority", url: "https://www.iana.org/help/example-domains", snippet: "IANA maintains example.com and example.org for documentation purposes." },
  { title: "IANA-managed Reserved Domains", url: "https://www.iana.org/domains/reserved", snippet: "Reserved example domains." },
  { title: "IANA example domains mirrored JSON", url: "https://mirror.test/iana-example-domains", snippet: "IANA example domains example IANA documentation." },
 ];
 assert.deepEqual(rankWebResearchResults("IANA example domains", rows, 3), rows);
});

test("positive site operators constrain the final candidates, not merely give a ranking bonus", () => {
 const rows = [
  { title: "IANA example domains", url: "https://iana.org.evil.test/fake", snippet: "IANA example domains" },
  { title: "IANA example domains", url: "https://www.iana.org/help/example-domains", snippet: "IANA example domains" },
  { title: "IANA example domains", url: "https://mirror.test/iana", snippet: "IANA example domains" },
 ];
 assert.deepEqual(rankWebResearchResults("site:IANA.org IANA example domains", rows, 3), [rows[1]]);
 assert.deepEqual(rankWebResearchResults("site:iana.org site:mirror.test IANA example domains", rows, 3), rows.slice(1));
});
