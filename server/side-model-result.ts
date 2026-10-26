import { abortable } from "../src/async-abort.ts";
import type { AssistantMsgLike, StageStreamEvent } from "../src/stage/engine.ts";
import { explicitProviderFailure } from "../src/stage/model-failure.ts";

export function readAssistantText(message: AssistantMsgLike | null): string {
	if (!message) return "";
	const raw = message as unknown as Record<string, unknown>;
	if (typeof raw.text === "string") return raw.text.trim();
	if (typeof raw.content === "string") return raw.content.trim();
	if (!Array.isArray(raw.content)) return "";
	return raw.content.map((part: unknown) => {
		if (typeof part === "string") return part;
		if (!part || typeof part !== "object") return "";
		const item = part as Record<string, unknown>;
		if (item.type !== undefined) return item.type === "text" && typeof item.text === "string" ? item.text : "";
		// Older untyped responses used text, content or value for plain text.
		if (typeof item.text === "string") return item.text;
		if (typeof item.content === "string") return item.content;
		if (typeof item.value === "string") return item.value;
		return "";
	}).join("").trim();
}

export type SideModelDelta = { kind: "text"; delta: string } | { kind: "error"; text: string };
/** SDK text_delta is not the browser's wire delta protocol. Never forward thinking or tool text. */
export async function collectSideModelResult(
	stream: AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> },
	options?: { forceNonStreaming?: boolean; signal?: AbortSignal; onDelta?: (event: SideModelDelta) => void },
): Promise<AssistantMsgLike> {
	let final: AssistantMsgLike | null = null;
	if (options?.forceNonStreaming) final = await abortable(stream.result(), options.signal);
	else {
		const iterator = stream[Symbol.asyncIterator]();
		try {
			while (true) {
				const next = await abortable(iterator.next(), options?.signal);
				if (next.done) break;
				const event = next.value;
				if (event.type === "done") { final = event.message ?? null; break; }
				if (event.type === "error") throw new Error(event.error?.errorMessage || `stopReason=${event.error?.stopReason ?? "?"}`);
				if (event.type === "text_delta" && event.delta) options?.onDelta?.({ kind: "text", delta: event.delta });
			}
		} finally { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
	}
	options?.signal?.throwIfAborted();
	if (!final) throw new Error("流未产出最终消息");
	if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage || `stopReason=${final.stopReason}`);
	const failure = explicitProviderFailure(readAssistantText(final));
	if (failure) throw new Error(failure);
	return final;
}
