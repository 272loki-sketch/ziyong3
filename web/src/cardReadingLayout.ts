/** Display-only layout for the static dossier card; never rewrites card files or prose. */
export function hasDossierReadingLayout(html: string): boolean {
	if (!/<details[\s>]/i.test(html)) return false;
	const classes = new Set<string>();
	for (const match of html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
		for (const name of (match[1] ?? match[2] ?? "").split(/\s+/)) classes.add(name);
	}
	return ["cxtd-box", "cxtd-head", "cxtd-body"].every(name => classes.has(name));
}

/** Keep the author's colours, avatar and native details control, change only reading geometry. */
export const DOSSIER_READING_LAYOUT_STYLE = `<style data-liyuan-card-layout="dossier-reader">
.cxtd-box.cxtd-box { box-sizing: border-box; width: 100%; max-width: none; margin: 12px 0; white-space: normal; }
.cxtd-box > details > .cxtd-head { box-sizing: border-box; gap: 16px; padding: 18px 24px; }
.cxtd-box .cxtd-title { min-width: 0; flex-wrap: wrap; font-size: 17px; line-height: 1.6; letter-spacing: 2px; white-space: normal; }
.cxtd-box .cxtd-body { box-sizing: border-box; padding: 22px 26px; max-height: none; overflow: visible; font-size: 16px; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; user-select: text; }
@media (max-width: 600px) {
 .cxtd-box > details > .cxtd-head { gap: 10px; padding: 14px 16px; }
 .cxtd-box .cxtd-title { font-size: 16px; letter-spacing: 1px; }
 .cxtd-box .cxtd-body { padding: 18px 16px; font-size: 15.5px; line-height: 1.9; }
}
</style>`;
