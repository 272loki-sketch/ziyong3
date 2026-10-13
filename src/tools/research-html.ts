/** Bounded inert HTML tokens shared by source reading and discovery parsing. */
export type ResearchHtmlToken = { kind: "text"; text: string } | {
	kind: "tag"; name: string; closing: boolean; selfClosing: boolean; attributes: Record<string, string>;
};
const blocked = new Set(["script", "style", "noscript", "svg", "head", "nav", "footer"]);
const space = (char: string) => /\s/u.test(char);
function attributes(raw: string): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	let i = 0;
	while (i < raw.length) {
		while (i < raw.length && (space(raw[i]) || raw[i] === "/")) i++;
		const start = i;
		while (i < raw.length && !space(raw[i]) && !["=", "/", ">"].includes(raw[i])) i++;
		if (i === start) { i++; continue; }
		const name = raw.slice(start, i).toLowerCase();
		while (i < raw.length && space(raw[i])) i++;
		let value = "";
		if (raw[i] === "=") {
			i++; while (i < raw.length && space(raw[i])) i++;
			const quote = raw[i] === '"' || raw[i] === "'" ? raw[i++] : "";
			const from = i;
			if (quote) { while (i < raw.length && raw[i] !== quote) i++; value = raw.slice(from, i); if (i < raw.length) i++; }
			else { while (i < raw.length && !space(raw[i]) && raw[i] !== ">") i++; value = raw.slice(from, i); }
		}
		if (!(name in result)) result[name] = value;
	}
	return result;
}
export function* researchHtmlTokens(input: string, maxChars: number): Generator<ResearchHtmlToken> {
	const html = input.slice(0, maxChars);
	// ASCII case folding preserves original UTF-16 positions (İ.toLowerCase does not).
	const lower = html.replace(/[A-Z]/g, char => char.toLowerCase());
	let from = 0;
	while (from < html.length) {
		const open = html.indexOf("<", from);
		if (open < 0) { yield { kind: "text", text: html.slice(from) }; break; }
		if (open > from) yield { kind: "text", text: html.slice(from, open) };
		if (html.startsWith("<!--", open)) {
			const end = html.indexOf("-->", open + 4); if (end < 0) break;
			from = end + 3; yield { kind: "text", text: " " }; continue;
		}
		let close = open + 1, quote = "";
		while (close < html.length) {
			const char = html[close];
			if (quote) { if (char === quote) quote = ""; }
			else if (char === '"' || char === "'") quote = char;
			else if (char === ">") break;
			close++;
		}
		if (close >= html.length) { yield { kind: "text", text: html.slice(open) }; break; }
		from = close + 1;
		const match = lower.slice(open + 1, Math.min(close, open + 16_385)).match(/^\s*(\/?)([a-z][a-z0-9:-]*)\b/);
		if (!match || close - open > 16_384) { yield { kind: "text", text: " " }; continue; }
		const name = match[2], closing = Boolean(match[1]), selfClosing = /\/\s*$/.test(html.slice(open + 1, close));
		if (!closing && blocked.has(name) && (!selfClosing || name !== "svg")) {
			const needle = `</${name}`; let end = lower.indexOf(needle, from);
			while (end >= 0 && !/[\s>]/.test(lower[end + needle.length] ?? "")) end = lower.indexOf(needle, end + needle.length);
			if (end < 0) break;
			const endClose = html.indexOf(">", end + needle.length); if (endClose < 0) break;
			from = endClose + 1; yield { kind: "text", text: " " }; continue;
		}
		yield { kind: "tag", name, closing, selfClosing, attributes: closing ? Object.create(null) : attributes(html.slice(open + 1 + match[0].length, close)) };
	}
}
export function readableHtmlText(input: string, maxChars = 160_000): string {
	return [...researchHtmlTokens(input, maxChars)].map(token => token.kind === "text" ? token.text : " ").join("");
}
export function decodeResearchHtmlText(value: string): string {
	return value.replace(/&(?:nbsp|#160);/gi, " ")
		.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
			const names: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
			if (names[entity.toLowerCase()]) return names[entity.toLowerCase()];
			const hex = entity[2].toLowerCase() === "x";
			const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
		});
}
