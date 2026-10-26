/** Source-bound planning inputs and receipts; no semantic judge or author-name heuristics. */
import { constantEntries, searchEntries } from '../lorebook.ts';
import type { LorebookEntry } from '../types.ts';
import { plotHash, type PlotCard } from './library.ts';
import type { PlotEvidence, PlotMechanism } from './types.ts';
export const PLOT_RELEVANCE_VERSION = 2;
export interface PlotHistoryRow { id: string; role: string; text: string }
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Keep the latest saved reply whole; older history is background, never a substitute for its ending. */
export function planningHistory(history: PlotHistoryRow[]): PlotHistoryRow[] {
 const last = history.findLastIndex(h => h.role === 'assistant');
 let budget = 28000;
 const kept: PlotHistoryRow[] = [];
 for (let i = history.length - 1; i >= Math.max(0, history.length - 12) && budget > 0; i--) {
  const source = history[i], max = i === last ? Math.max(source.text.length, 16000) : Math.min(3500, budget);
  const text = source.text.length <= max ? source.text : source.text.slice(-max);
  kept.unshift({ ...source, text }); budget -= text.length;
 }
 return kept;
}
export function planningLore(entries: LorebookEntry[], history: PlotHistoryRow[]) {
 const active = entries.filter(e => e.enabled && e.content.trim()), query = history.slice(-2).map(h => h.text).join('\n');
 const relevant = searchEntries(active, query, 12).map(hit => hit.entry);
 const seen = new Set<LorebookEntry>(); let budget = 14000, count = 0;
 return [...relevant, ...constantEntries(active)].flatMap(entry => {
  if (seen.has(entry) || budget <= 0 || count >= 18) return []; seen.add(entry); count++;
  const content = entry.content.slice(0, Math.min(3500, budget)); budget -= content.length;
  return [{ source: entry.source ?? 'card', entryKey: entry.entryKey ?? String(entry.uid), title: entry.comment, content }];
 });
}
export function plotMaterialKey(context: { modelKey: string; skill: string; worldLore?: LorebookEntry[] }, _history: PlotHistoryRow[]): string {
 return plotHash([PLOT_RELEVANCE_VERSION, context.modelKey, context.skill, (context.worldLore ?? []).filter(e => e.enabled).map(e => [e.source, e.entryKey, e.uid, e.constant, e.keys, e.content])]);
}
export function normalizePlanText(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ''); }
/** Exact provenance, not a claim that TS can prove literary/semantic quality. */
export function validatePlotGrounding(value: unknown, history: PlotHistoryRow[], card: PlotCard, initialReferences: PlotHistoryRow[] = []): { grounding: PlotEvidence[]; mechanism: PlotMechanism; signature: string } | undefined {
 const input = row(value), source = row(input.mechanism);
 const requiredId = history.at(-1)?.id ?? initialReferences[0]?.id;
 const sources = history.length ? history : initialReferences;
 const grounding: PlotEvidence[] = Array.isArray(input.grounding) ? input.grounding.slice(0, 4).flatMap(x => {
  const e = row(x); if (typeof e.entryId !== 'string' || typeof e.quote !== 'string' || e.quote.length < 4 || e.quote.length > 300) return [];
  return sources.some(h => h.id === e.entryId && h.text.includes(e.quote as string)) ? [{ entryId: e.entryId, quote: e.quote }] : [];
 }) : [];
 if (!grounding.some(e => e.entryId === requiredId)) return undefined;
 const mechanism: Partial<PlotMechanism> = {};
 for (const [key, field] of [['activity', 'surfaceActivity'], ['friction', 'friction'], ['change', 'microChange']] as const) {
  const part = row(source[key]), original = card[field];
  if (typeof part.quote !== 'string' || part.quote.length < 2 || part.quote.length > 300 || !original?.includes(part.quote) || typeof part.adaptation !== 'string' || part.adaptation.trim().length < 4 || part.adaptation.length > 600) return undefined;
  mechanism[key] = { quote: part.quote, adaptation: part.adaptation.trim() };
 }
 const parts = Object.values(mechanism).map(p => normalizePlanText(p.adaptation));
 if (new Set(parts).size !== 3) return undefined;
 if (parts.every(p => history.some(h => normalizePlanText(h.text).includes(p)))) return undefined;
 return { grounding, mechanism: mechanism as PlotMechanism, signature: plotHash(parts) };
}
