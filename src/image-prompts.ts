export interface ImagePromptBlock {
	start: number;
	end: number;
	prompt: string;
	incomplete?: boolean;
}

/** Display-only boundary retained when postprocessing unwraps the following tag. */
export const IMAGE_PROMPT_BOUNDARY = "\uE012";

/** Pure parser for historical image metadata; it has no generation capability. */
export function parseImagePrompt(raw: string) {
	const inner = raw.match(/image###([\s\S]*?)###/i)?.[1]?.trim() || raw.trim();
	const fields = [...inner.matchAll(/\b(Scene Composition|Character\s+(\d+)\s+(Prompt|UC))\s*:/gi)];
	const values = new Map(fields.map((field, index) => [
		field[1].toLowerCase().replace(/\s+/g, " "),
		inner.slice(field.index! + field[0].length, fields[index + 1]?.index ?? inner.length).trim(),
	]));
	const scene = values.get("scene composition");
	const characters: Array<{ prompt: string; uc: string; center: { x: number; y: number } }> = [];
	if (!scene) return { scene: inner, characters };
	for (let i = 1; i <= 8; i++) {
		const prompt = values.get(`character ${i} prompt`);
		if (!prompt) continue;
		const center = prompt.match(/\|\s*centers?\s*:\s*([\d.]+)\s*[,，]\s*([\d.]+)/i);
		characters.push({
			prompt: prompt.replace(/\|\s*centers?\s*:[^;\n]*/i, "").trim(),
			uc: values.get(`character ${i} uc`) || "",
			center: center ? { x: Number(center[1]), y: Number(center[2]) } : { x: 0.5, y: 0.5 },
		});
	}
	return { scene, characters };
}

/** Only explicit protocols are claimed; uncertain lines remain ordinary text. */
export function scanImagePromptBlocks(text: string): ImagePromptBlock[] {
	const blocks: ImagePromptBlock[] = [];
	const code = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)];
	const open = /<(image(?:Tag)?)\b[^>]*>|(?:【[^】\n]+】[ \t]*)?image###/gi;
	let match: RegExpExecArray | null;
	while ((match = open.exec(text))) {
		if (code.some(part => match!.index >= part.index! && match!.index < part.index! + part[0].length)) continue;
		const start = match.index;
		const bodyStart = open.lastIndex;
		const rest = text.slice(bodyStart);
		const next = (match[1] ? /<image(?:Tag)?\b/i : /<image(?:Tag)?\b|image###/i).exec(rest);
		const close = match[1] ? new RegExp(`</${match[1]}\\s*>`, "i").exec(rest) : /###/.exec(rest);
		// A nested opener cannot supply the previous image's closing delimiter.
		if (close && (!next || close.index < next.index)) {
			const end = bodyStart + close.index + close[0].length;
			// Wrapped protocols containing a truncated image### are not safe to generate.
			const body = rest.slice(0, close.index).trim();
			const incomplete = match[1] && /image###/i.test(body) && !/image###[\s\S]*###/i.test(body);
			blocks.push({ start, end, prompt: match[1] ? body : text.slice(start, end), ...(incomplete ? { incomplete: true } : {}) });
			open.lastIndex = end;
			continue;
		}
		if (match[1]) {
			// An explicit wrapper owns its body, including unknown metadata and prose.
			// Paired metadata children are only accepted before an adjacent protocol;
			// an unrelated following container must remain outside the image.
			let from = 0;
			let boundary = /<\/?[A-Za-z_\u4e00-\u9fff]|```|\uE012/i.exec(rest);
			const firstBoundary = boundary?.index ?? rest.length;
			while (boundary && !/image###/i.test(rest.slice(0, from + boundary.index))) {
				const childStart = from + boundary.index;
				const child = /^<([A-Za-z_\u4e00-\u9fff][\w.\-\u4e00-\u9fff]*)\b[^>]*>/i.exec(rest.slice(childStart));
				if (!child || /^image(?:Tag)?$/i.test(child[1])) break;
				const tag = child[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const tokens = new RegExp(`<(/?)${tag}(?=\\s|>)[^>]*>`, "gi");
				tokens.lastIndex = childStart;
				let depth = 0;
				let childEnd = -1;
				let token: RegExpExecArray | null;
				while ((token = tokens.exec(rest))) {
					depth += token[1] ? -1 : /\/\s*>$/.test(token[0]) ? 0 : 1;
					if (depth === 0) { childEnd = tokens.lastIndex; break; }
				}
				if (childEnd < 0 || /<image(?:Tag)?\b|```|\uE012/i.test(rest.slice(childStart, childEnd))) break;
				from = childEnd;
				if (/^\s*image###/i.test(rest.slice(from))) {
					boundary = /<\/?[A-Za-z_\u4e00-\u9fff]|```|\uE012/i.exec(rest.slice(from));
					break;
				}
				// Only another adjacent paired child can extend the metadata chain.
				if (!/^\s*</.test(rest.slice(from))) { from = 0; boundary = null; break; }
				boundary = /<\/?[A-Za-z_\u4e00-\u9fff]|```|\uE012/i.exec(rest.slice(from));
			}
			const hasMetadataProtocol = from > 0 && /^\s*image###/i.test(rest.slice(from));
			const end = bodyStart + (hasMetadataProtocol ? from + (boundary?.index ?? rest.length - from) : firstBoundary);
			blocks.push({ start, end, prompt: text.slice(start, end), incomplete: true });
			open.lastIndex = end;
			continue;
		}
		if (!/^\s*Scene\s+Composition\s*:/i.test(rest)) continue;
		// Bare protocols have no container ownership: retain uncertain prose outside.
		let end = bodyStart;
		for (const line of rest.matchAll(/[^\n]*(?:\n|$)/g)) {
			if (!line[0]) break;
			const value = line[0];
			const boundary = /<\/?[A-Za-z_\u4e00-\u9fff]|```|image###|\uE012/i.exec(value);
			const limit = boundary ? boundary.index : value.length;
			const candidate = value.slice(0, limit);
			if (candidate.trim() && !/^\s*(?:Scene\s+Composition\s*:|Character\s+\d+\s+(?:Prompt|UC)\s*:)/i.test(candidate) && !/^[\x20-\x7e]*[,;][\x20-\x7e]*\s*$/.test(candidate)) break;
			end += candidate.length;
			if (limit < value.length) break;
		}
		blocks.push({ start, end, prompt: text.slice(start, end), incomplete: true });
		open.lastIndex = end;
	}
	return blocks;
}
