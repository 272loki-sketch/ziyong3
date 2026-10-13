import { useEffect, useState, useRef } from "react";
import { apiGet } from "../api.ts";
import type { RequestRecord } from "../../../src/stage/request-journal.ts";
import { messageRoleLabel, phaseLabel, phasePurpose, requestStatusLabel, stopReasonLabel, TOKEN_HELP } from "../request-labels.ts";
import { IconClose } from "./icons.tsx";
import "./RequestInspector.css";

const fmt = (n: number | undefined) => n === undefined ? "未返回" : n.toLocaleString();
const ms = (n: number | undefined) => n === undefined ? "未记录" : (n / 1000).toFixed(3) + " 秒";
const inputUsage = (row: RequestRecord) => row.usage?.input === undefined ? undefined : row.usage.input + (row.usage.cacheRead ?? 0) + (row.usage.cacheWrite ?? 0);

export function RequestInspector({ onClose, contextTick }: { onClose: () => void; contextTick: number }) {
	const selectionTicket = useRef(0);
	const [rows, setRows] = useState<RequestRecord[]>([]), [detail, setDetail] = useState<RequestRecord | null>(null), [error, setError] = useState(""), [search, setSearch] = useState(""), [tick, setTick] = useState(0);
	useEffect(() => {
		let current = true;
		selectionTicket.current++; setRows([]); setDetail(null); setError("");
		apiGet<{ requests: RequestRecord[] }>("/api/request-inspector", { bypassCache: true }).then(data => { if (current) setRows(data.requests); }).catch(e => { if (current) setError(String(e.message || e)); });
		return () => { current = false; };
	}, [contextTick, tick]);
	useEffect(() => {
		const old = document.activeElement;
		document.body.classList.add("request-inspector-open");
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", key);
		return () => { window.removeEventListener("keydown", key); document.body.classList.remove("request-inspector-open"); if (old instanceof HTMLElement && old.isConnected) old.focus(); };
	}, [onClose]);
	const select = async (id: string) => {
		const ticket = ++selectionTicket.current; setError("");
		try { const row = await apiGet<RequestRecord>("/api/request-inspector?id=" + encodeURIComponent(id), { bypassCache: true }); if (ticket === selectionTicket.current) setDetail(row); }
		catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	};
	const shown = rows.filter(r => [r.provider, r.model, r.phase, phaseLabel(r.phase), r.status, requestStatusLabel(r.status), r.narrativeEntryId, r.sourceEntryId, r.id].join(" ").toLowerCase().includes(search.toLowerCase()));
	const payload = detail?.payload as Record<string, unknown> | undefined, context = detail?.context as Record<string, unknown> | undefined;
	return <div className="request-inspector-backdrop" onMouseDown={e => { if (e.currentTarget === e.target) onClose(); }}>
		<section className="request-inspector" role="dialog" aria-modal="true" aria-label="提示词查看器">
			<header><div><h2>提示词查看器</h2><p>实际请求 · 每次耗时 · 回执用量</p></div><button className="icon-btn" aria-label="关闭提示词查看器" onClick={onClose}><IconClose /></button></header>
			<div className="request-inspector-note">记录实际发送前的接口载荷，不把装配预览当实发。只有调用上下文时明确标识。旧轮次没有记录就留空；不重生成来补记录。接口未返回用量时显示“未返回”，不以字符数估算替代。{TOKEN_HELP} 中文仅用于说明标签，消息与完整请求保持原样。</div>
			{error && <p role="alert">{error}</p>}
			<div className="request-inspector-toolbar"><input aria-label="搜索请求" value={search} onChange={e => setSearch(e.target.value)} placeholder="模型、阶段、轮次、请求编号或状态" /><button className="act" onClick={() => setTick(n => n + 1)}>刷新请求</button><span>仅当前会话 / 卡 / 祖先分支 · 最近100次或64MiB</span></div>
			<div className="request-inspector-layout"><aside>
				{!shown.length && <p>{rows.length ? "没有匹配的请求，可使用中文标签或原始阶段编号搜索。" : "暂无实际请求记录。新调用开始记录；旧提示词预览不伪装为历史实发。"}</p>}
				{shown.map(row => <button className={detail?.id === row.id ? "active" : ""} key={row.id} onClick={() => void select(row.id)}>
					<strong title={row.phase}>{phaseLabel(row.phase)} · {row.model}</strong><small>{new Date(row.startedAt).toLocaleString()} · {requestStatusLabel(row.status)}</small>
					<span>{ms(row.durationMs)} · 输入 {fmt(inputUsage(row))} / 输出 {fmt(row.usage?.output)} 词元</span><code>轮次 {row.narrativeEntryId || row.sourceEntryId}</code>
				</button>)}
			</aside><main>{!detail ? <p>选择左侧一次请求，查看实发消息、工具定义和参数。</p> : <>
				<h3 title={detail.phase}>{phaseLabel(detail.phase)} · {detail.model}</h3><p>{phasePurpose(detail.phase)}</p>
				<dl>
					<dt>请求编号 / 轮次</dt><dd>{detail.id} / {detail.narrativeEntryId || detail.sourceEntryId}</dd>
					<dt>渠道 / 模型 / 状态</dt><dd>{detail.provider} / {detail.model} · {requestStatusLabel(detail.status)}</dd>
					<dt>结束原因</dt><dd title={detail.stopReason}>{stopReasonLabel(detail.stopReason)}</dd>
					<dt>耗时 / 首个文本或思考增量</dt><dd>{ms(detail.durationMs)} / {ms(detail.firstTokenMs)}（单次实际经过时间；并行请求不能相加当整拍耗时）</dd>
					<dt>输入 / 输出 / 总词元</dt><dd>{fmt(inputUsage(detail))} / {fmt(detail.usage?.output)} / {fmt(detail.usage?.totalTokens)} · {detail.usageSource === "missing" ? "未返回，不估算" : "模型接口用量回执"}（输入含缓存读取与写入）</dd>
					<dt>缓存读取 / 写入词元</dt><dd>{fmt(detail.usage?.cacheRead)} / {fmt(detail.usage?.cacheWrite)}</dd>
					<dt>记录来源</dt><dd>{detail.capture === "api-payload" ? "接口最终实发载荷（采样参数与工具处理后）" : "只有调用上下文；未取得实发载荷"}</dd>
				</dl>
				{Array.isArray(payload?.messages) ? payload.messages.map((message, index) => <details key={index} className="request-message"><summary>消息 {index + 1} · {messageRoleLabel(String((message as { role?: string }).role ?? "unknown"))}</summary><textarea aria-label={`请求消息 ${index + 1}`} readOnly rows={10} value={typeof (message as { content?: unknown }).content === "string" ? String((message as { content: string }).content) : JSON.stringify(message, null, 2)} /></details>) : <details open><summary>原始调用上下文（非实发载荷）</summary><textarea aria-label="SDK上下文" readOnly rows={14} value={JSON.stringify(context, null, 2)} /></details>}
				<details><summary>工具定义、采样参数与完整原始请求（JSON）</summary><textarea aria-label="完整实际请求" readOnly rows={16} value={JSON.stringify(payload ?? context, null, 2)} /></details>
				<p>内部网关重试或未公开计费不能从这些记录推断；记录不含鉴权请求头。下载内容包含私人提示词与故事，请勿公开。</p>
				<button className="act" onClick={() => { const a = document.createElement("a"), url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" })); a.href = url; a.download = `request-${detail.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>下载这次请求</button>
			</>}</main></div>
		</section>
	</div>;
}
