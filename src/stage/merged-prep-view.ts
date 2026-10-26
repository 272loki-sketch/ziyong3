/** Read-only presentation of the one native recall / plot / literary-director task.
 * Keep raw phase receipts untouched and never count the skipped legacy paths twice.
 */
import type { PhasePerformance } from './performance.ts';
export const MERGED_PREP_LABEL = '记忆召回 / 剧情推进 / 文学导演';
type Phases = Partial<Record<string, PhasePerformance>>;
export function mergedPrepView(prep: Record<string, unknown> = {}, phases: Phases = {}) {
 const director = phases['prep.director'], database = phases['prep.database'];
 const merged = prep.recallDirectorMerged === true || director?.reason === 'merged-database-recall' || director?.reason === 'missing-director-candidate' ||
  !!(database && director?.calls === 0 && director.durationMs === 0 && ['skipped','degraded'].includes(director.status ?? ''));
 if (!merged) return undefined;
 const status = prep.workflowStatus && typeof prep.workflowStatus === 'object' ? (prep.workflowStatus as Record<string, unknown>).director : undefined;
 const candidate = !!prep.literaryDirectionData && typeof prep.literaryDirectionData === 'object';
 const databaseFailed = ['degraded','failed','aborted'].includes(database?.status ?? '');
 const missing = director?.reason === 'missing-director-candidate' || status === 'degraded';
 return {
  label: MERGED_PREP_LABEL,
  status: databaseFailed ? 'degraded' as const : missing ? 'degraded' as const : candidate || director?.reason === 'merged-database-recall' ? 'success' as const : 'skipped' as const,
  summary: databaseFailed ? '原数据库合并准备未完整完成；按已获取资料继续，请核对逐次请求和候选结果。' : missing ? '原数据库合并执行，未交付有效导演候选；按已有事实继续，不另发导演请求。' : candidate || director?.reason === 'merged-database-recall' ? '同一次原数据库任务完成召回／推进并交付导演候选，不另发独立导演请求；请求成功不等于记忆命中。' : '原数据库召回／推进已接管，独立导演未调用；历史记录未单列候选归属，不把旧路径跳过解释为未召回。',
 };
}
export function displayPrepPhases(phases: Phases): Array<[string, PhasePerformance]> {
 const merged = mergedPrepView({}, phases);
 if (!merged) return Object.entries(phases).filter((row): row is [string, PhasePerformance] => !!row[1]);
 const hidden = new Set(['prep.director','prep.memoryRecall','prep.memoryArcs']);
 return Object.entries(phases).flatMap(([id, phase]) => {
  if (!phase) return [];
  if (hidden.has(id) && phase.calls === 0 && phase.durationMs === 0) return [];
  if (id === 'prep.database') return [['prep.recallDirector', {...phase, ...(merged.status === 'degraded' ? {status:'degraded' as const} : {}), ...(phases['prep.director']?.reason ? {reason:phases['prep.director']!.reason} : {})}] as [string,PhasePerformance]];
  return [[id,phase] as [string,PhasePerformance]];
 });
}
