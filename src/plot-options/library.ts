import { createHash } from "node:crypto";
import type { CorpusDailyPattern } from "../outline/corpus.ts";
export interface PlotCard extends CorpusDailyPattern {
    id: string;
    hash: string;
    docId: string;
}
export const plotHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function plotCards(rows: Array<CorpusDailyPattern & {
    docId: string;
}>): PlotCard[] {
    const seen = new Set<string>();
    return rows.flatMap(row => {
        if (!row.title?.trim() || !row.docId)
            return [];
        const id = `daily-${plotHash([row.docId, row.locator, row.title]).slice(0, 24)}`;
        if (seen.has(id))
            return [];
        seen.add(id);
        return [{ ...row, id, hash: plotHash(row) }];
    });
}
/** Corpus rarity and the latest scene take priority over common background/location words. */
export function retrievePlotCards(cards: PlotCard[], query: string, limit = 24, avoid: string[] = [], focus = ""): PlotCard[] {
    const termsOf = (value: string) => {
        const words = new Set((value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 500));
        for (const word of [...words]) if (/\p{Script=Han}/u.test(word)) for (let i = 0; i < word.length - 1; i++) words.add(word.slice(i, i + 2));
        return words;
    };
    const terms = termsOf(query), focused = termsOf(focus); for (const term of focused) terms.add(term);
    const texts = cards.map(card => [card.title, card.setting, card.surfaceActivity, card.initiative, card.sweetBeat, card.friction, card.microChange].join(" ").toLowerCase());
    const frequency = new Map([...terms].map(term => [term, texts.filter(t => t.includes(term)).length]));
    const ignored = new Set(avoid);
    return cards.map((card, index) => {
        let score = 0;
        for (const term of terms) if (texts[index].includes(term)) score += Math.min(term.length, 8) * Math.log1p(cards.length / (1 + (frequency.get(term) ?? 0))) * (focused.has(term) ? 3 : 1);
        return { card, index, score: score - (ignored.has(card.id) ? 30 : 0) };
    }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, Math.min(cards.length || 1, limit))).map(x => x.card);
}
