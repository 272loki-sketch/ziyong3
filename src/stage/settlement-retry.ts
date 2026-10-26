import { requestAbortError } from "../request-budget.ts";
import { classifyModelFailure, isNativeToolsUnsupported } from "./model-failure.ts";

/** One task-level retry boundary, including managed requests charged by their owner. */
export const settlementRetry = {
	wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) { reject(requestAbortError(signal)); return; }
			const cancel = () => { clearTimeout(timer); reject(requestAbortError(signal)); };
			const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 5000);
			signal.addEventListener("abort", cancel, { once: true });
		});
	},
};

export function settlementFailureRetryable(error: string): boolean {
	const failure = classifyModelFailure(error);
	if (["auth", "model", "quota", "content-filter"].includes(failure.kind)) return false;
	if (failure.kind === "rate-limit") return true;
	// Contextual errors can contain a sanitized diagnostic instead of the original envelope.
	if (/\b(?:401|402|403|404)\b|unauthori[sz]ed|authentication|invalid[_ -]?api[_ -]?key|\[(?:auth|model|quota|content-filter)(?::\d+)?\]|PROHIBITED_CONTENT|content_filter|SAFETY|BLOCKLIST|RECITATION|budget|quota|missing model|额度|预算|缺失|未配置|尚未配置|不在当前|已取消|来源.*变化|来源.*失效|切支/i.test(error) || isNativeToolsUnsupported(error)) return false;
	return failure.retryable || /不可解析|解析失败|截断|格式|schema/i.test(error);
}
