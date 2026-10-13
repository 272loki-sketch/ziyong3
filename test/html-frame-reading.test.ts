import test from "node:test";
import assert from "node:assert/strict";
import { hasDossierReadingLayout, DOSSIER_READING_LAYOUT_STYLE } from "../web/src/cardReadingLayout.ts";
import { buildSrcDoc } from "../web/src/frameDoc.ts";

const html = '<div class="cxtd-box"><details><summary class="cxtd-head">合成阅读器</summary><div class="cxtd-body">保留 &lt;%= author_code %&gt; 与 76vh 原文</div></details></div><style>.cxtd-box{max-width:650px}.cxtd-body{font-size:12px;max-height:400px;overflow-y:auto}</style>';
test("dossier layout detection requires the exact wrapper/header/body and a native details control", () => {
 assert.equal(hasDossierReadingLayout(html), true);
 assert.equal(hasDossierReadingLayout(html.replace('class="cxtd-box"', "class='extra cxtd-box'")), true);
 for (const name of ["cxtd-box", "cxtd-head", "cxtd-body"]) assert.equal(hasDossierReadingLayout(html.replaceAll(name, name + "-other")), false);
 assert.equal(hasDossierReadingLayout('<div class="cxtd-box cxtd-head cxtd-body">普通正文</div>'), false);
});
test("static seamless dossier gets geometry-only style after author CSS, with original prose and markup retained", () => {
 const doc = buildSrcDoc(html, false, true, 900);
 assert.ok(doc.includes(html), "the original static template/prose is not rewritten");
 assert.ok(doc.indexOf(DOSSIER_READING_LAYOUT_STYLE) > doc.indexOf('max-height:400px'));
 assert.match(doc, /font-size: 16px/); assert.match(doc, /max-height: none/);
 assert.ok(doc.includes('<details>'), "native initially collapsed state is preserved");
 assert.ok(!doc.includes('<script'), "live measurement belongs to the host, no script is added to a static frame");
});
test("reading adaptation is not applied to ordinary cards, agent show_html, or script/takeover frames", () => {
 assert.ok(!buildSrcDoc(html, false, false, 900).includes('data-liyuan-card-layout'));
 assert.ok(!buildSrcDoc(html + '<script>window.__native=1</script>', true, true, 900).includes('data-liyuan-card-layout'));
 assert.ok(!buildSrcDoc('<details><summary>普通卡</summary><p>内容</p></details>', false, true, 900).includes('data-liyuan-card-layout'));
});
test("full static document gets the reading adaptation inside the final body, not after html", () => {
 const doc = buildSrcDoc('<!doctype html><html><head></head><body>' + html + '</body></html>', false, true, 900);
 assert.ok(doc.indexOf('data-liyuan-card-layout') < doc.lastIndexOf('</body>'));
 assert.equal((doc.match(/data-liyuan-card-layout/g) ?? []).length, 1);
});
