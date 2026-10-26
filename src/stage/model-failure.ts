import type { RequestTimeoutScope } from "../request-budget.ts";
/** Failure facts for bounded recovery; never prompts, API keys or raw provider payloads. */
export type ModelFailureKind = "auth" | "model" | "quota" | "rate-limit" | "timeout" | "transport" | "format" | "content-filter" | "unknown";
export interface ModelAttemptDiagnostic {
	origin?: "local-timeout";
	timeoutScope?: RequestTimeoutScope;
	timeoutMs?: number;
	phase: string; step: string; provider: string; model: string; attempt: number;
	status: "success" | "failed" | "cancelled"; kind?: ModelFailureKind; statusCode?: number;
	durationMs: number; recovered?: boolean; reason?: string; validationOnly?: boolean;
}
/** Explicit upstream refusal facts, not ordinary story text discussing safety or a JSON field. */
const providerContentCode = (raw: string): boolean => /^(?:Provider\s+)?(?:finish[_ ]?reason|block(?:ed)?[_ ]?reason)\s*["':=]+\s*["']?(?:content_filter|PROHIBITED_CONTENT|SAFETY|BLOCKLIST|RECITATION)["']?\s*$/i.test(raw.trim());
export function isProviderContentRejection(value: string): boolean {
 const raw = value.trim();
 return /^(?:\[ProxySystem Error\]\s*|Request blocked due to safety settings\b|(?:Provider\s+)?(?:finish[_ ]?reason|block(?:ed)?[_ ]?reason)\s*:)/i.test(raw) &&
  (providerContentCode(raw) || /^request blocked due to safety settings\b/i.test(raw) || /^\[ProxySystem Error\](?:\s|$)[\s\S]*\b(?:PROHIBITED_CONTENT|content_filter|SAFETY|BLOCKLIST|RECITATION)\b/i.test(raw));
}
/** Whole transport envelopes only: never scan prose, code fences or arbitrary JSON error fields. */
export function explicitProviderFailure(text: string): string | undefined {
 const raw = text.trim();
 if (isProviderContentRejection(raw) || /^\[ProxySystem Error\](?:\s|$)/i.test(raw)) return raw;
 if (!raw.startsWith("{")) return undefined;
 try {
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).some(key => !["error", "message", "type", "code", "status", "status_code", "request_id", "id"].includes(key))) return undefined;
  const error = envelope.error;
  const detail = error && typeof error === "object" && !Array.isArray(error) ? error : envelope;
  const message = typeof error === "string" ? error : detail.message;
  const status = detail.status ?? detail.status_code ?? envelope.status ?? envelope.status_code;
  const code = detail.code ?? envelope.code;
  const typedError = typeof detail.type === "string" && /(?:^error$|_error$)/i.test(detail.type);
  const failedStatus = [status, code].some(value => /^(?:4\d\d|5\d\d)$/.test(String(value)));
   const rejection = code === "model_not_found" || [code, detail.type].some(value => typeof value === "string" && /^(?:content_filter|PROHIBITED_CONTENT|SAFETY|BLOCKLIST|RECITATION)$/i.test(value));
  const structuredError = detail === error && Object.keys(detail).every(key => ["message", "type", "code", "param", "status", "status_code"].includes(key));
  if (typeof message === "string" && message.trim() && (structuredError || typedError || failedStatus || rejection)) return raw;
 } catch { /* Non-JSON story text is not a provider envelope. */ }
 return undefined;
}
/** Terminal SDK output validation, shared by consumers and read-only request observation. */
export function modelResponseFailure(value: unknown, rejectTruncatedText = false): string | undefined {
 const message = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
 if (!message) return "No text: missing provider terminal message";
 const content = Array.isArray(message.content) ? message.content : [];
 const text = content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("");
 if (message.stopReason === "error" || message.stopReason === "aborted") return typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : explicitProviderFailure(text) ?? "Provider request failed without a completion receipt";
  const failure = explicitProviderFailure(text);
  if (failure) return failure;
  if (rejectTruncatedText && message.stopReason === "length") return "辅助模型输出触及上限，截断结果不采用";
 if (text.trim()) return undefined;
 const calls = content.filter(part => part?.type === "toolCall");
 if (message.stopReason === "toolUse" && calls.length && calls.every(part => typeof part.id === "string" && part.id.trim() && typeof part.name === "string" && part.name.trim() && part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments))) return undefined;
 return "No text: provider returned an empty terminal message";
}
export function classifyModelFailure(value: unknown): { kind: ModelFailureKind; retryable: boolean; statusCode?: number; reason: string } {
	const raw = value instanceof Error ? value.message : String(value ?? "模型请求失败");
	const code = /(?:^|[^\d])(400|401|402|403|404|408|409|422|429|500|502|503|504|520|522|523|524)(?:[^\d]|$)/.exec(raw);
	const statusCode = code ? Number(code[1]) : undefined;
	let kind: ModelFailureKind = "unknown";
	const causes = [raw, ...(value instanceof Error && value.cause instanceof Error ? [value.cause.message] : [])];
	// Strip only harness-owned diagnostic wrappers, never quotes in prose or JSON.
	const refusalCauses = causes.flatMap(text => [text, text.replace(/^(?:输出不可解析[:：]\s*|HTTP [45]\d\d\s*)/, "")]);
	const modelNotFound = causes.some(text => {
		const receipt = text.trim().replace(/^(?:Provider\s+)?HTTP [45]\d\d\s*:?\s*|^[45]\d\d\s*:\s*/i, "");
		if (/^(?:Provider\s+)?HTTP [45]\d\d\s*:?\s*model_not_found(?:\s*:|\s*$)/i.test(text.trim())) return true;
		if (!explicitProviderFailure(receipt) || !receipt.startsWith("{")) return false;
		const envelope = JSON.parse(receipt);
		return (envelope.error?.code ?? envelope.code) === "model_not_found";
	});
	if (refusalCauses.some(text => isProviderContentRejection(text) || (explicitProviderFailure(text) && /"(?:code|type)"\s*:\s*"(?:content_filter|PROHIBITED_CONTENT|SAFETY|BLOCKLIST|RECITATION)"/i.test(text)))) kind = "content-filter";
	else if (/(?:all \d+ linked account\(s\) are at their session limit|HTTP \d{3} rate limit|session[_ -]limit[_ -]exceeded)/i.test(raw)) kind = "rate-limit";
	else if ([401, 402, 403].includes(statusCode ?? 0) || /invalid[_ -]?api[_ -]?key|api key.*(?:invalid|expired)|unauthori[sz]ed|authentication|无可用.*key|no api key|凭证.*(?:过期|无效)/i.test(raw)) kind = "auth";
	else if (/insufficient[_ -]?quota|quota.*exceeded|credit.*(?:exhausted|insufficient)|余额不足/i.test(raw)) kind = "quota";
	else if (modelNotFound || statusCode === 404 || /model.*(?:not found|does not exist)|model\s+(?:is\s+)?unavailable\b|模型不存在|模型.*不可用/i.test(raw)) kind = "model";
	else if (statusCode === 429) kind = "rate-limit";
	else if ([408,504,522,524].includes(statusCode ?? 0) || /timeout|timed out|\bETIMEDOUT\b|超时/i.test(raw)) kind = "timeout";
	else if ((statusCode ?? 0) >= 500 || /network|fetch failed|connection (?:error|reset|closed)|ECONN|EAI_AGAIN|\b(?:ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH)\b|socket|stream.*(?:ended|closed)|网络|断流/i.test(raw)) kind = "transport";
	else if (/JSON|schema|报告.*解析|无文本|no text|结构|截断结果不采用/i.test(raw)) kind = "format";
	const reason = raw.replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]").replace(/(?:Bearer\s+|(?:sk|key|token)[-_])[A-Za-z0-9._-]{12,}/gi, "[redacted]").slice(0, 240);
	return { kind, retryable: ["rate-limit", "timeout", "transport", "format"].includes(kind), ...(statusCode ? { statusCode } : {}), reason };
}
export function modelDiagnosticsView(value: unknown): ModelAttemptDiagnostic[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap(x => {
		if (!x || typeof x !== "object" || !["success", "failed", "cancelled"].includes(x.status)) return [];
		const text = (v: unknown) => typeof v === "string" ? v.slice(0, 180) : "";
		return [{ phase: text(x.phase), step: text(x.step), provider: text(x.provider), model: text(x.model), attempt: Math.max(1,Math.min(8,Number(x.attempt)||1)), status:x.status,
			...(x.origin === "local-timeout" ? { origin: "local-timeout" as const, ...(["writer", "analysis", "generation", "plot-selection", "plot-semantic"].includes(x.timeoutScope) ? { timeoutScope: x.timeoutScope as RequestTimeoutScope } : {}), ...(typeof x.timeoutMs === "number" && Number.isFinite(x.timeoutMs) && x.timeoutMs > 0 ? { timeoutMs: Math.min(7200000, x.timeoutMs) } : {}) } : {}), ...(x.kind ? { kind: x.kind === "auth" && classifyModelFailure(x.reason).kind === "rate-limit" ? "rate-limit" : ["auth","model","quota","rate-limit","timeout","transport","format","content-filter","unknown"].includes(x.kind) ? x.kind : classifyModelFailure(x.reason).kind } : {}), ...(Number.isInteger(x.statusCode) ? { statusCode:x.statusCode } : {}),
			durationMs: Math.max(0,Math.min(7200000,Number(x.durationMs)||0)), ...(x.recovered ? { recovered:true } : {}), ...(x.validationOnly===true ? {validationOnly:true} : {}), ...(x.reason ? { reason:classifyModelFailure(x.reason).reason } : {}) } as ModelAttemptDiagnostic];
	}).slice(-100);
}

/** Only explicit rejection of the capability, never invalid arguments/schema or an upstream outage. */
export function isNativeToolsUnsupported(error: string): boolean {
	if (/invalid.*(?:schema|parameters|arguments)|(?:schema|parameters|arguments).*invalid|tools?\[\d+\]|tool[_ -]?choice|reasoning[_ -]?effort/i.test(error)) return false;
	return /(?:does not|doesn't|cannot) support (?:native |function |parallel )?(?:tools?|function[ _-]?calling)|(?:tools?|function[ _-]?calling) (?:are |is )?(?:not supported|unsupported|not allowed|disabled)|unsupported (?:parameter|feature)[: ]+["']?(?:tools|functions)["']?(?:\W|$)|unknown parameter[: ]+["']?(?:tools|functions)["']?(?:\W|$)|(?:不支持|未支持|不允许|已禁用).{0,12}(?:原生)?(?:工具调用|函数调用)/i.test(error);
}
