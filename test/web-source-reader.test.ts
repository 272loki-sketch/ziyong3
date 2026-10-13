import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeReadableBody, extractReadableExcerpt, isPublicIPv4, publicSourceUrl, readPublicWebSource, readablePageHeaders } from "../server/web-source-reader.ts";

test("guard only accepts public https DNS names", () => {
	assert.equal(publicSourceUrl("https://example.org/chapter")?.hostname, "example.org");
	for (const url of ["http://example.org", "https://127.0.0.1/", "https://localhost/",
		"https://sub.localhost/", "https://[::1]/", "https://me:pw@example.org/",
		"https://example.org:8443/path", "file:///etc/passwd"]) assert.equal(publicSourceUrl(url), null, url);
});
test("block local, metadata and reserved IPv4 networks", () => {
	for (const ip of ["127.0.0.1","10.1.2.3","172.16.0.1","192.168.1.10",
		"169.254.169.254","100.64.0.1","198.18.0.3","192.0.2.1","203.0.113.1","198.51.100.1","192.88.99.1"]) assert.equal(isPublicIPv4(ip), false, ip);
	for (const ip of ["8.8.8.8","1.1.1.1"]) assert.equal(isPublicIPv4(ip), true, ip);
});
test("strip active content while preserving story detail", () => {
	const html = '<head><title>Title</title></head><nav>menu</nav><main><h1>剧情时间线</h1><p>角色在第一章相遇 &amp; 交谈。</p><script>alert("x")</script></main>';
	assert.equal(extractReadableExcerpt(html), "剧情时间线 角色在第一章相遇 & 交谈。");
});
test("reject private target before any network access", async () => {
	assert.equal(await readPublicWebSource("https://127.0.0.1/internal"), null);
});

test("focus selects passage containing the requested evidence instead of the page header", () => {
	const preface = "<p>" + "导言内容".repeat(1500) + "</p>";
	const html = "<main>" + preface + "<p>重要剧情发生在第二学期末，人物才得知真相。</p></main>";
	const withoutFocus = extractReadableExcerpt(html);
	const withFocus = extractReadableExcerpt(html, "重要剧情");
	assert.equal(withoutFocus.includes("人物才得知真相"), false);
	assert.equal(withFocus.includes("人物才得知真相"), true);
});

test("GBK and Shift_JIS pages retain Chinese/Japanese names instead of replacement glyphs", () => {
	assert.equal(decodeReadableBody(Buffer.from([0xD6,0xD0,0xB9,0xFA]), "text/html; charset=gbk"), "中国");
	assert.equal(decodeReadableBody(Buffer.from([0x82,0xA0]), "text/plain; charset=Shift_JIS"), "あ");
	assert.equal(decodeReadableBody(Buffer.from("正文"), "text/html; charset=unknown-charset"), "正文");
});

test("focus prioritizes event-and-volume co-occurrence over repeated name mentions", () => {
	const heading = "坂柳有栖 角色介绍。".repeat(400);
	const exact = "坂柳有栖 在第十卷与同伴发生重要事件。";
	const html = `<main>${heading}<article>${exact}</article></main>`;
	const result = extractReadableExcerpt(html, "坂柳有栖 第十卷 重要事件");
	assert.ok(result.includes("第十卷与同伴发生重要事件"));
});

test("numeric hexadecimal HTML references preserve CJK source names", () => {
	assert.equal(extractReadableExcerpt("<p>&#x4e2d;&#x56fd; &amp; &#20013;&#22269;</p>"), "中国 & 中国");
});

test("page response gates reject redirects, unknown encodings, non-text and declared oversized bodies", () => {
	assert.equal(readablePageHeaders(200, {"content-type":"text/html; charset=utf-8","content-length":"159000"}), true);
	assert.equal(readablePageHeaders(302, {"content-type":"text/html"}), false);
	assert.equal(readablePageHeaders(200, {"content-type":"application/octet-stream"}), false);
	assert.equal(readablePageHeaders(200, {"content-type":"text/html","content-encoding":"unsupported"}), false);
	assert.equal(readablePageHeaders(200, {"content-type":"text/plain","content-length":"160001"}), false);
	assert.equal(readablePageHeaders(200, {"content-type":"text/plain","content-length":"invalid"}), false);
});

test("URL/IP spelling variants and credentials never bypass public address checks",()=>{
	for(const value of ["https://2130706433/","https://0x7f000001/","https://127.1/","https://[::ffff:127.0.0.1]/","https://[2001:db8::1]/","https://localhost./","https://example.org@127.0.0.1/","https://example.org:80/","https://foo.invalid/"+"x".repeat(2050)])assert.equal(publicSourceUrl(value),null,value);
	for(const value of ["0x7f.0.0.1","1.1.1","01.1.1.1","1.1.1.","100.127.255.255","0.1.1.1","255.255.255.255"])assert.equal(isPublicIPv4(value),false,value);
});
test("HTML meta charset is honored and text/plain markup is preserved",()=>{
	const html=Buffer.concat([Buffer.from('<meta charset="gbk"><p>'),Buffer.from([0xd6,0xd0,0xb9,0xfa]),Buffer.from('</p>')]);
	assert.ok(decodeReadableBody(html,"text/html").includes("中国"));
	assert.equal(extractReadableExcerpt("The operator < and > signs", "", false),"The operator < and > signs");
});
test("exact IANA special prefixes do not block public 192.0.33/24 sources; Azure host VIP stays blocked",()=>{
	assert.equal(isPublicIPv4("192.0.33.8"),true);for(const ip of ["192.0.0.1","192.0.2.1","168.63.129.16"])assert.equal(isPublicIPv4(ip),false,ip);
});
test("header/scripture names and mismatched closing tags cannot erase the article",()=>{
	const html='<head><title>Meta</title></head><header>Public heading</header><main><scripture>Original passage</scripture><p>Exact historical fact.</p></main><footer>Navigation footer</footer>';
	assert.equal(extractReadableExcerpt(html),'Public heading Original passage Exact historical fact.');
});
test("malformed 160KB HTML does not cause quadratic event-loop blocking",async()=>{
	const {performance}=await import("node:perf_hooks");const at=performance.now();
	assert.equal(extractReadableExcerpt("<script>".repeat(20000)),"");assert.equal(extractReadableExcerpt("<!--".repeat(40000)),"");
	assert.equal(extractReadableExcerpt("<".repeat(160000)).length,4000);
	assert.ok(performance.now()-at<2000,"bounded page size alone must not permit multi-second regex denial of service");
});
test("a Unicode case-expanding character before inactive content cannot corrupt HTML source positions",()=>{
	assert.equal(extractReadableExcerpt('<main>İstanbul<script>untrusted command</script><p>Exact public fact.</p></main>'),'İstanbul Exact public fact.');
});
test("HTML script self-closing syntax cannot expose inactive code as source evidence",()=>{
	assert.equal(extractReadableExcerpt('<script/>untrusted code</script><main>Real public source.</main>'),'Real public source.');
	assert.equal(extractReadableExcerpt('<svg/><main>Real public source.</main>'),'Real public source.');
});
