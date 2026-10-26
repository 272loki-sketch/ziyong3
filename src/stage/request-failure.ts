import { LocalRequestTimeoutError, isLocalRequestTimeout, requestAbortError, type RequestTimeoutScope } from "../request-budget.ts";
import { classifyModelFailure, type ModelFailureKind } from "./model-failure.ts";
export interface RequestFailure {
 origin: "local-timeout" | "cancelled" | "provider" | "sdk";
 kind: ModelFailureKind;
 reason: string;
 statusCode?: number;
 transportCode?: string;
 timeoutScope?: RequestTimeoutScope;
 timeoutMs?: number;
}
/** Reason text is sanitized; never attach headers, SDK exception objects or credentials. */
export function requestFailure(value: unknown, signal?: AbortSignal, credential?: unknown): RequestFailure {
 const cause = signal?.aborted ? requestAbortError(signal) : value;
 const underlying = cause instanceof Error ? cause.cause : undefined;
 const code = underlying && typeof underlying === "object" && "code" in underlying ? underlying.code : undefined;
 const transportCode = typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED"].includes(code) ? code : undefined;
 const message = (cause instanceof Error ? cause.message : String(cause ?? "模型请求失败")) + (transportCode ? ` [${transportCode}]` : "");
 const classified = classifyModelFailure(typeof credential === "string" && credential ? message.split(credential).join("[redacted]") : message);
 if (cause instanceof LocalRequestTimeoutError) return { origin: "local-timeout", kind: "timeout", reason: classified.reason, timeoutScope: cause.scope, timeoutMs: cause.timeoutMs };
 if (isLocalRequestTimeout(cause)) return { origin: "local-timeout", kind: "timeout", reason: classified.reason };
 if (signal?.aborted) return { origin: "cancelled", kind: "unknown", reason: classified.reason };
 return { origin: classified.statusCode || classified.kind === "content-filter" ? "provider" : "sdk", kind: classified.kind, reason: classified.reason, ...(classified.statusCode ? { statusCode: classified.statusCode } : {}), ...(transportCode ? { transportCode } : {}) };
}
