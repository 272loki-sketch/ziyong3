/** The dossier's first-floor view is an indented variable snapshot, not a list of update operations.
 * Read an already stored, exact-message MVU snapshot; never replay JSONPatch or seed from another floor.
 */
import { stringify } from "yaml";
import { hasDossierReadingLayout } from "./cardReadingLayout.ts";
import { applyCardSkin } from "./cardSkin.ts";
import type { SkinMacros } from "./richContentParts.ts";

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const BODY = /(<div\b[^>]*>)(\s*(?:<Analysis>[\s\S]*?<\/Analysis>\s*)?<JSONPatch>[\s\S]*?<\/JSONPatch>\s*)(<\/div\s*>)/gi;
const SOURCE = /^\s*(?:<Analysis>[\s\S]*?<\/Analysis>\s*)?<JSONPatch>[\s\S]*?<\/JSONPatch>\s*$/i;
function isBody(opening: string): boolean {
	const attr = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(opening);
	return (attr?.[1] ?? attr?.[2] ?? "").split(/\s+/).includes("cxtd-body");
}
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function needsDossierSnapshot(html: string): boolean {
	return hasDossierReadingLayout(html) && [...html.matchAll(BODY)].some(match => isBody(match[1]));
}

/** Reuse the enabled card's static shell for delegated MVU; this is not author text or a variable patch. */
export function delegatedDossierShell(text: string, skin?: SkinMacros | null): string | null {
	if (!skin || hasDossierReadingLayout(text) || /<(?:UpdateVariable|initvar)\b/i.test(text)) return null;
	for (const rule of skin.rules) {
		if (!hasDossierReadingLayout(rule.replace) || /<script\b|<%/i.test(rule.replace) || !rule.source.includes("UpdateVariable")) continue;
		const html = applyCardSkin("<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>", [rule], skin);
		if (needsDossierSnapshot(html)) return html;
	}
	return null;
}

/** Match the first floor's two-space, key/value hierarchy. The original card controls all typography. */
export function buildDossierReadingView(source: string, snapshot?: unknown): string | null {
	const data = record(snapshot);
	if (!SOURCE.test(source) || !data || !Object.keys(data).length) return null;
	try {
		const text = stringify(data, { indent: 2, lineWidth: 0, defaultKeyType: "PLAIN", defaultStringType: "PLAIN" });
		return `<span data-liyuan-dossier-view="snapshot">
${escapeHtml(text)}</span>`;
	} catch { return null; }
}

/** Change only a later floor's protocol body. The first-floor initvar and original HTML/CSS stay intact. */
export function projectDossierReadingHtml(html: string, snapshot?: unknown, status?: "loading" | "unavailable"): string {
	if (!hasDossierReadingLayout(html)) return html;
	return html.replace(BODY, (original, opening: string, source: string, closing: string) => {
		if (!isBody(opening)) return original;
		const view = buildDossierReadingView(source, snapshot) ?? (status ? `<span data-liyuan-dossier-view="${status}">${status === "loading" ? "正在读取本楼已存状态卷宗…" : "本楼暂无对应的 MVU 已存状态，未代用其他楼层数据。原始更新指令仍保留在源码中。"}</span>` : null);
		return view === null ? original : opening + view + closing;
	});
}

/** Existing authorized plugin context contains branch-scoped message storage. Do not fall back to the
 * latest floor, chat-level values, an ancestor, a different swipe, or the generic rp-state projection.
 */
export function selectDossierSnapshot(context: unknown, binding: { entryId: string; entryScope: string }): Record<string, unknown> | null {
	const ctx = record(context);
	if (!ctx || ctx.scopeKey !== binding.entryScope || !Array.isArray(ctx.visibleEntryIds) || !ctx.visibleEntryIds.includes(binding.entryId) || !Array.isArray(ctx.chat)) return null;
	const message = ctx.chat.map(record).find(row => row?.__liyuanEntryId === binding.entryId);
	if (!message || message.is_user !== false || message.__liyuanUnfinished === true) return null;
	const swipe = message.swipe_id === undefined ? 0 : message.swipe_id;
	if (typeof swipe !== "number" || !Number.isSafeInteger(swipe) || swipe < 0) return null;
	const variables = record(record(record(ctx.state)?.messages)?.[binding.entryId])?.variables;
	const slot = Array.isArray(variables) ? variables[swipe] : swipe === 0 ? variables : null;
	const data = record(record(slot)?.stat_data);
	return data && Object.keys(data).length ? data : null;
}
