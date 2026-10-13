/** Decode a same-author continuation receipt, not free prose or another author's rewrite. */
export type AuthorRecoveryError = "invalid-json" | "ambiguous-json" | "invalid-suffix";
export type AuthorRecoveryReceipt = { ok: true; suffix: string } | { ok: false; reason: AuthorRecoveryError };
export const AUTHOR_RECOVERY_CONTRACT = '【恢复回执合同，优先于原格式输出合同】本次响应只返回唯一 JSON 对象 {"suffix":"紧接原稿末尾的片段"}，不输出包装标签、代码围栏、说明或完整原稿。原材料的正文与附属格式只在 suffix 字符串内部接续；失败回执不是草稿，不得追加或重演。';
/** Only explicitly identified transient transport timeouts, never generic failures. */
export function isAuthorTransportTimeout(error: string): boolean {
 if (/auth|unauthori[sz]ed|forbidden|api.?key|model.?cap|context.{0,20}(?:limit|length|window)|cancel|abort|401|403|鉴权|取消|上下文/i.test(error)) return false;
 return /\b(?:stream|queue|transport)[ _-]+(?:timeout|timed out)\b/i.test(error);
}
export function parseAuthorRecoveryReceipt(text: string): AuthorRecoveryReceipt {
 const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
 const objects: unknown[] = [];
 try { objects.push(JSON.parse(trimmed)); }
 catch {
  // Original card containers, fenced JSON and short explanations may surround a
  // valid receipt. Respect string escaping; a greedy brace regexp corrupts suffix text.
  for (let start = 0; start < text.length; start++) {
   if (text[start] !== "{") continue;
   let depth = 0, quoted = false, escaped = false, end = -1;
   for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { end = i; break; }
   }
   if (end < 0) break;
   try { objects.push(JSON.parse(text.slice(start, end + 1))); } catch { /* Never repair JSON by inventing source characters. */ }
   start = end;
  }
 }
 const candidates = objects.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, "suffix"));
 if (candidates.length > 1) return { ok: false, reason: "ambiguous-json" };
 if (!candidates.length) return { ok: false, reason: "invalid-json" };
 const suffix = candidates[0].suffix;
 if (typeof suffix !== "string" || !suffix.trim()) return { ok: false, reason: "invalid-suffix" };
 return { ok: true, suffix };
}
