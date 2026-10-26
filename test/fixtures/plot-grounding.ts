/** Synthetic fake-model receipts, never production/card-derived data. */
export function syntheticPlotGrounding(data: any) {
 const card = data.candidates[0];
 const source = data.recentHistory.at(-1) ?? data.initialReferences?.[0];
 return { grounding: source ? [{ entryId: source.id, quote: source.text.slice(-120) }] : [], mechanism: {
  activity: { quote: card.surfaceActivity.slice(0, 120), adaptation: '一起分工整理旧书，遇到新的具体任务' },
  friction: { quote: card.friction.slice(0, 120), adaptation: '对分类标准有不同意见，双方协商可行的办法' },
  change: { quote: card.microChange.slice(0, 120), adaptation: '通过实际合作重新认识彼此的做事习惯' },
 } };
}
