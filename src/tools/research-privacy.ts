/** Local fail-closed checks, not a claim of semantic de-identification. */
/** Shared final egress check; never sends private text to a classifier. */
export function containsPrivateSearchMaterial(query: string): boolean {
    try { query = decodeURIComponent(query).normalize("NFKC").replace(/\p{Cf}/gu, ""); } catch { return true; }
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:sk-(?:proj-)?|gh[pousr]_|xox[baprs]-|bearer\s+)[a-z0-9_-]{8,}|-----BEGIN\s+(?:RSA|EC|OPENSSH|PRIVATE)\s+KEY|(?:password|api[_-]?key|access[_-]?token|secret)\s*[=:：]\s*\S+/i.test(query)) return true;
    for (const match of query.matchAll(/(?:^|[^\d])(\+?\d[\d ()+.-]{8,}\d)(?!\d)/g)) {
        const digits = match[1].replace(/\D/g, "");
        if (digits.length >= 10 && digits.length <= 15) return true;
    }
    return false;
}
export interface ResearchPrivacyContext { privateTerms?: string[]; privateTexts?: string[]; publicTerms?: string[] }
const comparable = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{White_Space}\p{Punctuation}\p{Cf}]/gu, "");
// Turn-owned contexts remain weakly held; unchanged long ancestry is normalized once.
// Values, not array positions, key the cache; changing public authorization resets it.
const sourceTextCache = new WeakMap<ResearchPrivacyContext, { publicKey: string; texts: Map<string, string> }>();
export function privateQueryReason(query: string, context: ResearchPrivacyContext): string | undefined {
    if (containsPrivateSearchMaterial(query)) return "查询包含凭据或联系方式";
	let decoded = query;
	try { decoded = decodeURIComponent(query); } catch { return "查询编码无效"; }
	const approved = new Set((context.publicTerms ?? []).map(comparable));
    const text = comparable(decoded);
    const publicKey = JSON.stringify([...approved].sort());
    let cached = sourceTextCache.get(context);
    if (!cached || cached.publicKey !== publicKey) {
        cached = { publicKey, texts: new Map() }; sourceTextCache.set(context, cached);
    }
	if ((context.privateTerms ?? []).some(term => !approved.has(comparable(term)) && comparable(term).length >= 2 && text.includes(comparable(term))))
		return "查询包含当前会话的受保护身份或角色名";
	// Catch copied prose, even when punctuation/spacing has been changed. Do not send
	// private material to another model/service for classification.
	if (text.length >= 8) {
		let privateQuery = text;
        for (const term of approved) if (term.length >= 2) privateQuery = privateQuery.split(term).join(" ");
        for (const material of context.privateTexts ?? []) {
            let privateText = cached.texts.get(material);
            if (privateText === undefined) {
                privateText = comparable(material);
                for (const term of approved) if (term.length >= 2) privateText = privateText.split(term).join(" ");
                cached.texts.set(material, privateText);
            }
            for (const length of [12, 8]) for (let i = 0; i <= privateQuery.length - length; i++) {
                const span = privateQuery.slice(i, i + length);
                // Short copied numeric/opaque identifiers are protected without
                // treating every long natural-language public noun as a secret.
                if (length === 8 && ![...span].some(char => char >= "0" && char <= "9")) continue;
                if (!span.includes(" ") && privateText.includes(span)) return "查询包含复制的私人上下文片段";
            }
        }
	}
	return undefined;
}
