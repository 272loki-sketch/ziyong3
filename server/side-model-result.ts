import { abortable } from "../src/async-abort.ts";
import type { AssistantMsgLike, StageStreamEvent } from "../src/stage/engine.ts";

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
	return final;
}
