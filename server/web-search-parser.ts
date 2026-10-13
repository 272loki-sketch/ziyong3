/** Search-engine HTML is untrusted data, not a browser DOM or evidence of canon. */
import { researchHtmlTokens, decodeResearchHtmlText } from "../src/tools/research-html.ts";
import type { WebResearchResult } from "../src/tools/web-research.ts";
export function parseSearchHtml(html: string, engine: "duck" | "bing"): WebResearchResult[] {
	const rows: WebResearchResult[] = [];
	let current: WebResearchResult | undefined;
	let capture: { name: string; depth: number; type: "title" | "snippet"; parts: string[]; chars: number } | undefined;
	let liDepth = 0, headingDepth = 0;
	const finish = () => {
		if (current?.title && current.url) rows.push(current);
		current = undefined; capture = undefined; headingDepth = 0;
	};
	const finishCapture = () => {
		if (capture && current) current[capture.type] = decodeResearchHtmlText(capture.parts.join("")).replace(/\s+/g, " ").trim().slice(0, capture.type === "title" ? 300 : 1200);
		const snippet = capture?.type === "snippet"; capture = undefined;
		if (snippet && engine === "duck") finish();
	};
	for (const token of researchHtmlTokens(html, 1_500_000)) {
		if (rows.length >= 8) break;
		if (token.kind === "text") {
			if (capture && capture.chars < 8192) { const text = token.text.slice(0, 8192 - capture.chars); capture.parts.push(text); capture.chars += text.length; }
			continue;
		}
		if (capture && (token.name === "br" || (token.closing && ["div", "p", "li"].includes(token.name)))) capture.parts.push(" ");
        const classes = new Set((token.attributes.class ?? "").toLowerCase().split(/\s+/));
		if (engine === "bing" && token.name === "li") {
			if (!token.closing && classes.has("b_algo")) { finish(); current = { title: "", url: "", snippet: "" }; liDepth = 1; }
			else if (current && !token.closing && !token.selfClosing) liDepth++;
			else if (current && token.closing && --liDepth <= 0) finish();
			continue;
		}
		if (engine === "bing" && current && token.name === "h2") headingDepth += token.closing ? -1 : 1;
		if (engine === "duck" && !token.closing && token.name === "a" && classes.has("result__a")) {
			finish(); let url = decodeResearchHtmlText(token.attributes.href ?? "");
			try { const wrapped = new URL(url, "https://duckduckgo.com"); url = wrapped.searchParams.get("uddg") ?? wrapped.href; } catch {}
			current = { title: "", url, snippet: "" };
			capture = { name: token.name, depth: 1, type: "title", parts: [], chars: 0 }; continue;
		}
		if (engine === "bing" && current && !capture && !current.title && !token.closing && token.name === "a" && headingDepth > 0) {
			current.url = decodeResearchHtmlText(token.attributes.href ?? "");
			capture = { name: token.name, depth: 1, type: "title", parts: [], chars: 0 }; continue;
		}
		if (current && !capture && !token.closing && ((engine === "duck" && classes.has("result__snippet")) || (engine === "bing" && token.name === "p"))) {
			capture = { name: token.name, depth: 1, type: "snippet", parts: [], chars: 0 }; continue;
		}
		if (capture && token.name === capture.name) {
			if (token.closing) { if (--capture.depth <= 0) finishCapture(); }
			else if (!token.selfClosing) capture.depth++;
		}
	}
	if (rows.length < 8) { if (capture) finishCapture(); finish(); }
	return rows.slice(0, 8);
}
