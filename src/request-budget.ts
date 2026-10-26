/** Local deadlines are not provider failures or user cancellation. No prompt/model policy here. */
export type RequestTimeoutScope = "writer" | "analysis" | "generation" | "plot-selection" | "plot-semantic";
export class LocalRequestTimeoutError extends Error {
 readonly origin = "local-timeout";
 readonly scope: RequestTimeoutScope;
 readonly timeoutMs: number;
 constructor(scope: RequestTimeoutScope, timeoutMs: number, label: string) {
  super(`${label}超时（本地时限 ${timeoutMs}ms）`);
  this.name = "LocalRequestTimeoutError";
  this.scope = scope; this.timeoutMs = timeoutMs;
 }
}
export function analysisRequestTimeoutMs(config: { analysisTimeoutMinutes?: number }): number {
 const minutes = config.analysisTimeoutMinutes;
 return Math.max(1, Math.min(30, typeof minutes === "number" && Number.isFinite(minutes) ? minutes : 10)) * 60_000;
}
export function isLocalRequestTimeout(value: unknown): value is LocalRequestTimeoutError | (Error & { name: "TimeoutError" }) {
 return value instanceof LocalRequestTimeoutError || value instanceof Error && value.name === "TimeoutError";
}
/** Preserve explicit parent causes; the platform's default AbortError remains a plain cancellation. */
export function requestAbortError(signal: AbortSignal, fallback = "请求已取消"): Error {
 const reason: unknown = signal.reason;
 return reason instanceof Error && reason.name !== "AbortError" ? reason : new Error(typeof reason === "string" && reason ? reason : fallback);
}
export function createRequestDeadline(parent: AbortSignal | undefined, timeoutMs: number, scope: RequestTimeoutScope, label: string) {
 if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw Error("请求时限必须是有效的正毫秒数");
 const controller = new AbortController();
 const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
 const timeoutError = new LocalRequestTimeoutError(scope, timeoutMs, label);
 const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
 return { signal, dispose: () => clearTimeout(timer) };
}
