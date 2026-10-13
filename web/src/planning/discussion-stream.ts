import type { OutlineChatResponse } from "./types.ts";

/** Incremental SSE framing; blank lines delimit events, comments never reset pending data. */
export class DiscussionEventParser {
	#buffer = "";
	#event = "message";
	#data: string[] = [];
	feed(text: string): Array<{ event: string; data: string }> {
		this.#buffer += text;
		if (this.#buffer.length > 4 * 1024 * 1024) throw new Error("导演流式响应过大");
		const events: Array<{ event: string; data: string }> = [];
		while (true) {
			const at = this.#buffer.search(/[\r\n]/);
			if (at < 0 || (this.#buffer[at] === "\r" && at === this.#buffer.length - 1)) break;
			const line = this.#buffer.slice(0, at);
			this.#buffer = this.#buffer.slice(at + (this.#buffer.slice(at, at + 2) === "\r\n" ? 2 : 1));
			if (line === "") {
				if (this.#data.length) events.push({ event: this.#event, data: this.#data.join("\n") });
				this.#event = "message"; this.#data = [];
			} else if (!line.startsWith(":")) {
				const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
				let value = colon < 0 ? "" : line.slice(colon + 1);
				if (value.startsWith(" ")) value = value.slice(1);
				if (field === "event") this.#event = value;
				else if (field === "data") this.#data.push(value);
			}
		}
		return events;
	}
}
function textPayload(data: string): string {
	try { const value = JSON.parse(data); if (typeof value === "string") return value; } catch { /* Legacy unencoded SSE. */ }
	return data;
}
export async function readDiscussionStream(response: Response, onDelta?: (text: string) => void, onStatus?: (text: string) => void): Promise<OutlineChatResponse> {
	if (!response.ok) {
		let message = `创作对谈请求失败（HTTP ${response.status}）`;
		try { const body = await response.json(); if (typeof body?.error === "string") message = body.error; } catch { /* Non-JSON gateway errors. */ }
		throw new Error(message);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("创作对谈响应没有内容");
	const decoder = new TextDecoder(), parser = new DiscussionEventParser();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
				if (event.event === "delta") onDelta?.(textPayload(event.data));
				else if (event.event === "status") {
					try { const status = JSON.parse(event.data); if (typeof status.message === "string") onStatus?.(status.message); } catch { /* Optional progress. */ }
				} else if (event.event === "error") throw new Error(textPayload(event.data));
				else if (event.event === "done") {
					let result: OutlineChatResponse;
					try { result = JSON.parse(event.data); } catch { throw new Error("导演回复无法解析，请重试"); }
					if (!result || typeof result.reply !== "string" || !result.reply.trim() || typeof result.requestId !== "string") throw new Error("导演没有返回有效回答，请重试");
					return result;
				}
			}
		}
		throw new Error("回复连接提前断开，尚未收到完成确认；请刷新讨论记录核对，输入已保留");
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
/** Show only the provisional user-facing answer, never the model's JSON envelope. */
export function discussionReplyPreview(raw: string): string {
	const match = /"(?:answer|reply)"\s*:\s*"/.exec(raw);
	if (!match) return "";
	let text = "";
	for (let i = match.index + match[0].length; i < raw.length; i++) {
		const char = raw[i];
		if (char === '"') break;
		if (char !== "\\") { text += char; continue; }
		const escape = raw[++i];
		if (escape === undefined) break;
		if (escape === "u") {
			const hex = raw.slice(i + 1, i + 5);
			if (!/^[0-9a-f]{4}$/i.test(hex)) break;
			text += String.fromCharCode(parseInt(hex, 16)); i += 4;
		} else {
			const decoded = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }[escape];
			if (decoded === undefined) break;
			text += decoded;
		}
	}
	return text;
}
