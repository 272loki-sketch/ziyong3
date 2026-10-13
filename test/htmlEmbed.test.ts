import assert from "node:assert/strict";
import test from "node:test";
import {
	claimFencedHtmlDocument,
	findFencedHtmlDocument,
	isFullInterface,
	looksLikeHtmlDocument,
	splitHtmlParts,
} from "../web/src/htmlEmbed.ts";
import { prepareDisplayText } from "../src/postprocess.ts";
import { splitRichContentParts } from "../web/src/richContentParts.ts";

test("splitHtmlParts: plain text", () => {
	const p = splitHtmlParts("hello\n\nworld");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: fenced html", () => {
	const p = splitHtmlParts('前\n```html\n<div class="phone">hi</div>\n```\n后');
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.includes("phone"));
		assert.equal(p[1].scripts, false);
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: scripts fence", () => {
	const p = splitHtmlParts("```html scripts\n<script>1</script>\n```");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "html");
	if (p[0].kind === "html") assert.equal(p[0].scripts, true);
});

test("looksLikeHtmlDocument", () => {
	assert.equal(looksLikeHtmlDocument("<!DOCTYPE html><html></html>"), true);
	assert.equal(looksLikeHtmlDocument("not html"), false);
});

test("splitHtmlParts: 正文中的顶层 <div> 块切为 html 段(皮肤产物形态)", () => {
	const text = '雨停了。\n<div style="x">\n<status>\nHP: 80\n</status>\n</div>\n她抬头。';
	const p = splitHtmlParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.startsWith("<div"));
		assert.ok(p[1].html.endsWith("</div>"));
		assert.equal(p[1].scripts, false);
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: style 与 class 容器作为同一个 HTML fragment", () => {
	const text = `前文\n<!-- skin --!>\n<style>.cote-elite-content{color:red}</style>\n<div class="cote-elite-content">状态</div>\n后文`;
	const p = splitHtmlParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.includes("<style>"));
		assert.ok(p[1].html.includes('class="cote-elite-content"'));
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: 外层 class 容器包住 style 时整个外层容器进同一帧", () => {
	const text = `前文\n<div class="cote-elite-container"><style>.cote-elite-content{color:red}</style><div class="cote-elite-content">状态</div></div>\n后文`;
	const p = splitHtmlParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.startsWith('<div class="cote-elite-container">'));
		assert.ok(p[1].html.includes(".cote-elite-content"));
		assert.ok(p[1].html.endsWith("</div>"));
	}
});

test("splitHtmlParts: 嵌套同名 div 深度配平", () => {
	const text = "<div><div>内</div></div>后文";
	const p = splitHtmlParts(text);
	assert.equal(p[0].kind, "html");
	if (p[0].kind === "html") assert.equal(p[0].html, "<div><div>内</div></div>");
	assert.equal(p[1].kind, "text");
});

test("splitHtmlParts: 自定义标签不触发块切分(留给 statusBlocks)", () => {
	const p = splitHtmlParts("<StatusBlock>\nHP: 80\n</StatusBlock>");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 行中 <div>(非行首)不切,避免误伤叙事里的尖括号", () => {
	const p = splitHtmlParts("他说 <div> 不是标签");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 未闭合 div 当普通文本", () => {
	const p = splitHtmlParts("<div>没有闭合");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("isFullInterface: 整条消息即界面", () => {
	assert.equal(isFullInterface('<div style="x">全屏界面</div>'), true);
	assert.equal(isFullInterface("<!DOCTYPE html><html><body>x</body></html>"), true);
	assert.equal(isFullInterface("正文\n<div>局部</div>"), false);
	assert.equal(isFullInterface("纯正文"), false);
});

test("splitHtmlParts: 裸整份文档带【开场】前缀——整份进一帧，不被切碎", () => {
	// 梨园自己给开场白加「【开场 · 卡名】\n」(greeting.ts:16)。围栏那条判据一直容忍这个前缀，
	// 裸文档这条原先要求文档落在第 0 位 → 整份文档被按顶层元素切成一堆碎帧（v1.4.1 实锤）。
	const doc = '<html>\n<style>\n.gj-wrap{color:#fff}\n</style>\n<div class="gj-wrap"><p>一</p></div>\n<div class="gj-nav">二</div>\n</html>';
	const p = splitHtmlParts(`【开场 · 某卡】\n${doc}`);
	assert.equal(p.length, 2, "前缀一段文本 + 文档一帧");
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	assert.ok(p[1].kind === "html" && p[1].html.includes("<style>"), "<style> 留在帧内");
	assert.ok(p[1].kind === "html" && p[1].html.includes("gj-nav"), "文档尾部也在同一帧里");
});

test("splitHtmlParts: 前缀 + 裸文档 + 文档后的内容——文档一帧，尾巴照常另行认领", () => {
	const doc = "<!doctype html>\n<html><body><p>页</p></body></html>";
	const p = splitHtmlParts(`【开场 · 某卡】\n${doc}\n\n收尾叙事一句。`);
	assert.equal(p.filter((x) => x.kind === "html").length, 1, "只认一份文档");
	const tail = p[p.length - 1];
	assert.equal(tail.kind, "text");
	assert.ok(tail.kind === "text" && tail.text.includes("收尾叙事"), "文档之后的文本不被卷进帧");
});

test("looksLikeHtmlDocument: 带前缀时仍为 false（前缀容忍只做在 splitHtmlParts 里）", () => {
	assert.equal(looksLikeHtmlDocument("【开场 · 某卡】\n<html><body>x</body></html>"), false);
});

/** 仅合成不可联网的 loader 字符串；测试不执行脚本、不读取角色卡。 */
const shortBodyLoader = (page: string) =>
	`<body>\n<script>$("body").load("https://example.invalid/${page}.html");</script>\n</body>`;
const unlabelledFence = (html: string) => "```\n" + html + "\n```";

for (const { name, marker, page } of [
	{ name: "首页", marker: "SYNTHETIC_HOME", page: "home" },
	{ name: "自定义开局", marker: "SYNTHETIC_CUSTOM", page: "custom" },
]) {
	test(`无语言短 body: ${name} 合成 loader 经皮肤后进入单交互帧`, () => {
		const html = shortBodyLoader(page);
		assert.ok(html.length < 200);
		const fence = unlabelledFence(html);
		const skin = {
			rules: [{ name, source: marker, flags: "g", replace: fence }],
			charName: "合成卡",
			userName: "合成用户",
		};
		const prefix = "【开场 · 合成卡】\n";
		const prepared = prepareDisplayText(prefix + marker, skin);
		assert.equal(prepared, prefix + fence, "规则命中且完整保留 loader");
		assert.deepEqual(claimFencedHtmlDocument(fence), { html, scripts: true });
		const found = findFencedHtmlDocument(prepared);
		assert.ok(found);
		assert.equal(found.start, prefix.length);
		assert.equal(found.end, prepared.length);
		assert.equal(isFullInterface(prepared), true);
		const expected = [{ kind: "text", text: prefix }, { kind: "html", html, scripts: true }];
		assert.deepEqual(splitRichContentParts(prepared, skin), expected);
		assert.deepEqual(splitRichContentParts(prefix + marker, skin), expected, "未跑 wire 的本地皮肤同样可识别");
	});
}

test("无语言短 body: 互动标记沿用，静态 body 不获脚本权限", () => {
	for (const { html, scripts } of [
		{ html: '<body class="short">静态内容</body>', scripts: false },
		{ html: '<BODY>\r\n<script type="module">void 0;</script>\r\n</BODY>', scripts: true },
		{ html: '<body onload="void 0">事件内容</body>', scripts: true },
	]) {
		assert.deepEqual(splitHtmlParts(unlabelledFence(html)), [{ kind: "html", html, scripts }]);
	}
});

test("无语言短 body: 只认首个闭合 fence，各 loader 与前后正文独立", () => {
	const first = shortBodyLoader("home");
	const second = shortBodyLoader("custom");
	const text = "前文\n" + unlabelledFence(first) + "\n" + unlabelledFence(second) + "\n后文";
	assert.deepEqual(splitHtmlParts(text), [
		{ kind: "text", text: "前文\n" },
		{ kind: "html", html: first, scripts: true },
		{ kind: "html", html: second, scripts: true },
		{ kind: "text", text: "\n后文" },
	]);
});

test("无语言短 body: 不完整结构、孤立 script 与普通代码均不认领", () => {
	const html = shortBodyLoader("home");
	for (const [name, text] of [
		["body 不闭合", unlabelledFence(html.replace("</body>", ""))],
		["缺 body 开标签", unlabelledFence(html.replace("<body>", ""))],
		["fence 不闭合", "```\n" + html],
		["仅 script", unlabelledFence('<script>$("body").load("https://example.invalid/home.html");</script>')],
		["普通正文代码", unlabelledFence('$("body").load("https://example.invalid/home.html");')],
		["prose", unlabelledFence("这只是普通文字，不是界面。")],
		["裸 body 无 fence", html],
		["body 前夹正文", unlabelledFence("普通文字\n" + html)],
		["body 后夹正文", unlabelledFence(html + "\n普通文字")],
		["多个 body 根", unlabelledFence("<body>一</body><body>二</body>")],
		["自闭合 body", unlabelledFence("<body />不完整根</body>")],
		["嵌套且不完整 body", unlabelledFence("<body><body>未闭合外层</body>")],
	]) {
		assert.equal(findFencedHtmlDocument(text), null, name);
		assert.deepEqual(splitHtmlParts(text), [{ kind: "text", text }], name);
	}
});

test("无语言短 body: 不得跨首个闭合 fence 拼出 body 闭合", () => {
	const text = unlabelledFence("<body>\n<script>void 0;</script>")
		+ "\n" + "普通正文".repeat(60) + "\n" + unlabelledFence("</body>");
	assert.ok(text.length > 200, "外围长正文不能绕过短 body 的严格闭合守卫");
	assert.equal(findFencedHtmlDocument(text), null);
	assert.deepEqual(splitHtmlParts(text), [{ kind: "text", text }]);
});

test("无语言短 body: 明确的非 HTML code 语言不得获得交互帧", () => {
	for (const language of ["js", "javascript", "ts", "python", "json", "text", "sh", "markdown"]) {
		const text = "```" + language + "\n" + shortBodyLoader("home") + "\n```\n";
		assert.equal(findFencedHtmlDocument(text), null, language);
		assert.deepEqual(splitHtmlParts(text), [{ kind: "text", text }], language);
	}
});

test("无语言短 body: 其它 UI 根仍保留 200 字符保护", () => {
	for (const tag of ["div", "section"]) {
		const root = (length: number) => `<${tag}>${"x".repeat(length - tag.length * 2 - 5)}</${tag}>`;
		const short = root(199);
		const long = root(200);
		assert.equal(short.length, 199);
		assert.equal(long.length, 200);
		assert.equal(findFencedHtmlDocument(unlabelledFence(short)), null, tag);
		assert.deepEqual(claimFencedHtmlDocument(unlabelledFence(long)), { html: long, scripts: false }, tag);
	}
});


test("splitHtmlParts: wrapper-specific trailing stylesheet stays with its HTML, never in an empty second iframe", () => {
	const text = '前文\n<div class="reader-box"><details><summary>合成卷宗</summary><div>正文</div></details></div>\n<style>.reader-box{color:gold}.reader-box details{padding:20px}</style>\n后文';
	const parts = splitHtmlParts(text);
	assert.equal(parts.length, 3);
	assert.equal(parts[0].kind, "text"); assert.equal(parts[1].kind, "html"); assert.equal(parts[2].kind, "text");
	if (parts[1].kind === "html") {
		assert.ok(parts[1].html.includes('<style>'));
		assert.ok(parts[1].html.includes('<div class="reader-box">'));
		assert.equal(parts[1].scripts, false);
	}
});
test("splitHtmlParts: trailing styles cannot cross prose, take unrelated styles, or absorb a script", () => {
	for (const tail of ['正文分界\n<style>.reader-box{color:gold}</style>', '<style>.other-box{color:gold}</style>', '<script>window.__unrelated=1</script>']) {
		const parts = splitHtmlParts('<div class="reader-box">合成正文</div>\n'+tail);
		const first = parts.find(part => part.kind === "html");
		assert.ok(first && first.kind === "html");
		if (first?.kind === "html") {
			assert.equal(first.html, '<div class="reader-box">合成正文</div>');
			assert.equal(first.scripts, false);
		}
	}
});
test("splitHtmlParts: inline styles and adjacent ID-specific stylesheet retain their original bytes", () => {
	const html = '<section id="reading-report"><style>#reading-report{color:gold}</style><p>合成正文</p></section>\n<!-- author style -->\n<style>@media(max-width:600px){#reading-report{padding:16px}}</style>';
	const parts = splitHtmlParts(html);assert.equal(parts.length,1);assert.equal(parts[0].kind,"html");
	if (parts[0].kind === "html") assert.equal(parts[0].html,html);
});

test("splitHtmlParts: retaining adjacent CSS does not promote a plain wrapper into a script-enabled frame", () => {
	const parts = splitHtmlParts('<div class="reader-box" onclick="window.__notAllowed=1">合成内容</div>\n<style>.reader-box{color:gold}</style>');
	assert.equal(parts.length, 1); assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") assert.equal(parts[0].scripts, false);
});

test("splitHtmlParts: CSS text in an attached stylesheet does not upgrade existing static inline-style permissions", () => {
	const parts = splitHtmlParts('<div class="reader-box"><style>.reader-box{padding:2px}</style><p>合成内容</p></div>\n<style>.reader-box::after{content:"onclick=not_a_handler"}</style>');
	assert.equal(parts.length, 1); assert.equal(parts[0].kind, "html");
	if (parts[0].kind === "html") assert.equal(parts[0].scripts, false);
});
