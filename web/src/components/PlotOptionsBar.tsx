import { useCallback, useEffect, useRef, useState } from "react";
import { requestPlotOptions } from "../plot-options.ts";
import type { PlotChoiceInput, PlotOptionsView, PlotRecommendation } from "../../../src/plot-options/types.ts";
import "./plot-options.css";
export interface PlotDraft { choice: PlotChoiceInput; title: string }
interface Props {
 scope: string; busy: boolean; draft: PlotDraft | null;
 onChoose(option: PlotRecommendation, contextKey: string): void;
 onClear(): void;
}
const progressNames = { preparing: "准备铺垫", seeded: "已有承接证据", engaged: "展开中", completed: "已收束", shelved: "暂时搁置" };
export function PlotOptionsBar({ scope, busy, draft, onChoose, onClear }: Props) {
 const [view, setView] = useState<PlotOptionsView | null>(null);
 const [error, setError] = useState("");
 const [pending, setPending] = useState(false);
 const [query, setQuery] = useState("");
 const [library, setLibrary] = useState<{ total: number; cards: Array<{ id: string; title: string; activity: string; setting: string }> } | null>(null);
 const [offset, setOffset] = useState(0);
 const request = useRef(0), currentScope = useRef(scope); currentScope.current = scope;
 const load = useCallback(async () => {
  const id = ++request.current;
  try { const next = await requestPlotOptions<PlotOptionsView>("/api/plot-options"); if (id === request.current) { setView(next); setError(""); } }
  catch (e) { if (id === request.current) setError(e instanceof Error ? e.message : "剧情选项读取失败"); }
 }, [scope]);
 useEffect(() => {
  setView(null); setLibrary(null); setQuery(""); setOffset(0); setPending(false); void load();
  const timer = window.setInterval(() => void load(), 10000);
  return () => { request.current++; window.clearInterval(timer); };
 }, [load]);
 useEffect(() => { if (draft && view && draft.choice.contextKey !== view.contextKey) onClear(); }, [view, draft, onClear]);
 const act = async (path: string, body: Record<string, unknown>, method: "POST" | "PUT" = "POST") => {
  if (!view || pending) return;
  const bound = scope; setPending(true); setError("");
  try {
   const next = await requestPlotOptions<PlotOptionsView>(path, method, { ...body, contextKey: view.contextKey, controlKey: view.controlKey });
   if (currentScope.current === bound) { request.current++; setView(next); }
  } catch (e) { if (currentScope.current === bound) setError(e instanceof Error ? e.message : "剧情筹备操作失败"); }
  finally { if (currentScope.current === bound) setPending(false); }
 };
 const browse = async (start = 0) => {
  const bound = scope; setError("");
  try {
   const rows = await requestPlotOptions<NonNullable<typeof library>>(`/api/plot-options/library?q=${encodeURIComponent(query)}&offset=${start}`);
   if (currentScope.current === bound) { setLibrary(rows); setOffset(start); }
  } catch (e) { if (currentScope.current === bound) setError(e instanceof Error ? e.message : "卡库读取失败"); }
 };
 return <section className="plot-options-bar composer-shell" aria-label="剧情选项">
  <details>
   <summary><strong>剧情选项</strong><span>{view?.enabled ? view.running ? "后台筹备中" : `${view.options.length} 个推荐 · 每 ${view.interval} 楼刷新` : "日常剧情筹备未开启"}</span></summary>
   <p className="field-hint">独立剧情方向，不改原行动选项。点击只填入草稿，编辑并发送后才开始引导；主题保留，路径可变。</p>
   <div className="plot-options-controls">
    <label><input type="checkbox" checked={view?.enabled ?? false} disabled={!view || pending} onChange={e => void act("/api/plot-options/settings", { enabled: e.target.checked }, "PUT")} />开启后台选材</label>
    <label><input type="checkbox" aria-label="混合语义检索" checked={view?.semantic ?? false} disabled={!view || pending || view.running} onChange={e => void act("/api/plot-options/settings", { semantic: e.target.checked }, "PUT")} />混合语义检索</label>
    <label>刷新周期 <select aria-label="剧情选材刷新周期" value={view?.interval ?? 5} disabled={!view || pending} onChange={e => void act("/api/plot-options/settings", { interval: Number(e.target.value) }, "PUT")}><option value={5}>5 楼</option><option value={10}>10 楼</option></select></label>
    <button type="button" className="drawer-btn" disabled={!view?.enabled || view.running || pending} onClick={() => void act("/api/plot-options/refresh", {})}>重新筹备</button>
    <button type="button" className="drawer-btn" onClick={() => void load()}>刷新状态</button>
   </div>
   {view?.semantic && <div className="plot-semantic-status" aria-live="polite">
    <label className="plot-options-controls">嵌入批量 <select aria-label="日常卡嵌入批量" value={view.embeddingBatchSize ?? 32} disabled={view.running || pending} onChange={e => void act("/api/plot-options/settings", { embeddingBatchSize: Number(e.target.value) }, "PUT")}><option value={1}>1 条（兼容单条接口）</option><option value={8}>8 条</option><option value={16}>16 条</option><option value={32}>32 条</option></select></label>
    <p className="field-hint">批量响应出现重复 index 时可选 1 条；不会忽略索引错误或自动拆分收费重试。</p>
    <p className="field-hint">向量索引 {view.retrieval?.indexed ?? 0}/{view.libraryCount} 张 · {view.retrieval?.phase === "indexing" ? "后台增量建立中" : view.retrieval?.configured ? `嵌入模型：${view.retrieval.model ?? "已配置"}` : "云端嵌入未配置"}</p>
    <p className="field-hint">复用设置 → 嵌入连接中的云端 embedding；首次建立索引与新剧情查询会发送素材/有界上下文并产生嵌入费用。本地哈希不作为语义检索；不会启用旧记忆库。</p>
    {view.retrieval?.message && <p className="field-hint">{view.retrieval.message}</p>}
    {view.lastRetrieval && <p className="field-hint">最近检索：{view.lastRetrieval.method === "hybrid" ? "关键词＋语义融合" : view.lastRetrieval.method === "manual" ? "手动指定" : "关键词回退"} · 嵌入尝试 {view.lastRetrieval.requests} 次 · 用量 {view.lastRetrieval.requests === 0 ? "本次未发起嵌入请求" : view.lastRetrieval.inputTokens === null ? "供应商未报告，不能按零计" : `${view.lastRetrieval.inputTokens} tokens`}{view.lastRetrieval.message ? ` · ${view.lastRetrieval.message}` : ""}</p>}
    <button type="button" className="drawer-btn" disabled={!view.enabled || view.running || pending || !view.retrieval?.configured} onClick={() => { if (window.confirm("重建当前嵌入模型的日常卡索引会重新发送素材并产生嵌入费用；不改记忆库或正文。是否继续？")) void act("/api/plot-options/reindex", {}); }}>重建日常卡语义索引</button>
   </div>}
   {view && !view.modelConfigured && <p className="field-hint">请先在设置 → 模型插头配置“日常剧情筹备”。此岗位独立，不借用导演模型。</p>}
   {view && <p className="field-hint">可用日常卡 {view.libraryCount} 张。无合适素材时不强行推荐；筹备失败不影响正文。</p>}
   {(error || view?.error) && <div className="plot-options-error" role="alert">{error || view?.error}</div>}
   {view?.active && <div className="plot-options-active"><strong>当前引导：{view.active.option.title}</strong><span>{view.active.progress ? progressNames[view.active.progress.status] : "已选方向 · 准备铺垫"}</span>
    {view.active.sourceAvailable === false && <small>来源卡已变更或移除，暂停投送旧方案；请重新筹备并选择。</small>}
    {view.active.progress?.note && <p>{view.active.progress.note}</p>}
    <button type="button" className="drawer-btn" disabled={busy || pending} onClick={() => void act("/api/plot-options/cancel", {})}>结束当前引导</button>
    {!view.enabled && <small>模块已关闭，引导暂停；已发生的正文保留。</small>}
   </div>}
   <div className="plot-options-grid">{view?.options.map(option => <article key={option.id}>
    <button type="button" className="plot-option-pick" onClick={() => onChoose(option, view.contextKey)} aria-label={`选择剧情：${option.title}`}>{option.title}</button>
    <p>{option.experience}</p><small>{option.whyNow}</small>
    <details><summary>接入参考</summary>{option.mechanism && <div className="plot-mechanism"><p>活动：{option.mechanism.activity.adaptation}</p><p>互动阻力：{option.mechanism.friction.adaptation}</p><p>微变化：{option.mechanism.change.adaptation}</p></div>}<p>{option.entryCondition}</p>{option.prerequisites.map((x, i) => <p key={i}>{x}</p>)}</details>
   </article>)}</div>
   <details className="plot-library"><summary>手动选材 · 浏览完整卡库</summary>
    <div className="plot-options-controls"><input className="field-input" aria-label="搜索日常剧情卡" placeholder="活动、场景或互动机制" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void browse(); } }} /><button className="drawer-btn" type="button" onClick={() => void browse()}>搜索卡库</button></div>
    {library?.cards.map(card => <article key={card.id}><strong>{card.title}</strong><p>{card.activity}</p><small>{card.setting}</small><button type="button" className="drawer-btn" disabled={!view?.enabled || view.running || pending} onClick={() => void act("/api/plot-options/refresh", { cardId: card.id })}>为此卡筹备入口</button></article>)}
    {library && <div className="plot-options-controls"><span>{offset + 1}–{Math.min(offset + 20, library.total)} / {library.total}</span><button type="button" className="drawer-btn" disabled={offset === 0} onClick={() => void browse(offset - 20)}>上一页</button><button type="button" className="drawer-btn" disabled={offset + 20 >= library.total} onClick={() => void browse(offset + 20)}>下一页</button></div>}
   </details>
  </details>
  {draft && <div className="plot-direction-draft" role="status"><span>草稿剧情方向：<strong>{draft.title}</strong> · 尚未提交</span><button type="button" className="drawer-btn" onClick={onClear}>取消草稿引导</button></div>}
 </section>;
}
