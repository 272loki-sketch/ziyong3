import { useEffect, useRef, useState } from "react";
import "../npc-parallel.css";

type Status = { scopeKey: string; sourceEntryId: string; revision: number; upstreamCommit?: string; installed: boolean; enabled: boolean; autoUpdate: boolean; busy: boolean; version?: string; commit?: string; previousVersion?: string; candidateVersion?: string; pendingActivation?: boolean; updateAvailable?: boolean; lastError?: string; model?: { provider: string; id: string }; receipt?: { status: string; changed: boolean; calls: number; error?: string; reason?: string; hits?: number }; settings?: Record<string, unknown> };
const actionLabels: Record<string, string> = { install: "安装原版", config: "保存开关", check: "检查更新", update: "更新并验收", rollback: "回退上一版", settings: "保存规则" };

export function VeridisRewritePanel({ contextTick, storyBusy = false, onOpenSettings, onDirtyChange }: { contextTick: number; storyBusy?: boolean; onOpenSettings?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [error, setError] = useState("");
	const [feedback, setFeedback] = useState("");
	const [loading, setLoading] = useState(true);
	const [action, setAction] = useState("");
	const [editor, setEditor] = useState(false);
	const [draft, setDraft] = useState("");
	const [draftError, setDraftError] = useState("");
	const [dirty, setDirty] = useState(false);
	useEffect(() => { onDirtyChange?.(dirty || !!action); }, [dirty, action, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	const generation = useRef(0);
	const operation = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const stale = useRef(false);
	const currentContext = useRef(contextTick);
	currentContext.current = contextTick;

	const request = async (path: string, signal: AbortSignal, method = "GET", body?: unknown) => {
		const response = await fetch(`/api/veridis-rewrite/${path}`, {
			method, credentials: "same-origin", cache: "no-store",
			signal: AbortSignal.any([signal, AbortSignal.timeout(method === "GET" ? 15_000 : 180_000)]),
			...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
		if (!data || typeof data.installed !== "boolean" || typeof data.enabled !== "boolean" || typeof data.autoUpdate !== "boolean" || typeof data.busy !== "boolean" || typeof data.scopeKey !== "string" || typeof data.sourceEntryId !== "string" || !Number.isInteger(data.revision)) {
			throw new Error("状态格式不完整，已暂停写操作。请重新读取。");
		}
		return data as Status;
	};
	const reload = async () => {
		if (operation.current) return;
		let preserveDraft = dirty;
		if (stale.current && dirty) {
			if (!window.confirm("来源已变化。放弃旧来源未保存的规则编辑，读取当前设置？")) return;
			preserveDraft = false;
			setDirty(false); setEditor(false); setDraft("");
		}
		stale.current = false;
		controller.current?.abort();
		const current = new AbortController(); controller.current = current;
		const token = ++generation.current;
		setLoading(true);
		try {
			const next = await request("status", current.signal);
			if (token === generation.current && currentContext.current === contextTick) {
				if (preserveDraft && status && (next.scopeKey !== status.scopeKey || next.sourceEntryId !== status.sourceEntryId || next.revision !== status.revision)) {
					stale.current = true;
					setError("服务端规则或来源已变化，草稿仍保留。请复制需要的内容后重新读取设置。");
				} else { setStatus(next); setError(""); }
			}
		} catch (cause) {
			if (token === generation.current && currentContext.current === contextTick && !current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally { if (token === generation.current && currentContext.current === contextTick) setLoading(false); }
	};
	useEffect(() => {
		if (dirty) {
			stale.current = true; operation.current = false; setAction(""); setLoading(false);
			setError("故事来源已变化，规则草稿仍保留；请复制需要的内容后重新读取设置。");
			return () => { generation.current++; controller.current?.abort(); };
		}
		setStatus(null); setError(""); setFeedback(""); setAction(""); setEditor(false); setDraft(""); setDraftError(""); setDirty(false); operation.current = false;
		void reload();
		return () => { generation.current++; controller.current?.abort(); };
	}, [contextTick]);

	const busy = storyBusy || !!status?.busy || !!action;
	const blocked = busy || loading || !status || !!error || stale.current;
	const run = async (name: string, method = "POST", payload?: object) => {
		if (operation.current || blocked || !status) return;
		operation.current = true;
		controller.current?.abort();
		const current = new AbortController(); controller.current = current;
		const token = ++generation.current;
		setAction(name); setFeedback("");
		try {
			const next = await request(name, current.signal, method, { ...payload, scopeKey: status.scopeKey, sourceEntryId: status.sourceEntryId, revision: status.revision, upstreamCommit: status.upstreamCommit });
			if (token !== generation.current || currentContext.current !== contextTick) return;
			if (next.scopeKey !== status.scopeKey || next.sourceEntryId !== status.sourceEntryId) throw new Error("来源已变化，请重新读取状态；旧操作结果未显示为成功。");
			setStatus(next); setError("");
			if (name === "settings") { setDirty(false); setDraft(JSON.stringify(next.settings ?? {}, null, 2)); }
			setFeedback(next.pendingActivation ? "候选已下载，尚未切换；等待兼容验收和宿主空闲。" : `${actionLabels[name]}请求已返回；当前版本：${next.version ?? "未提供"}。`);
		} catch (cause) {
			if (token === generation.current && currentContext.current === contextTick && !current.signal.aborted) setError(`${cause instanceof Error ? cause.message : String(cause)} 请先重新读取状态核对，操作可能已提交。`);
		} finally {
			if (token === generation.current && currentContext.current === contextTick) { operation.current = false; setAction(""); }
		}
	};

	return <article className="npc-parallel-panel veridis-panel" aria-label="Veridis Rewrite 来源与更新" aria-busy={loading || !!action}>
		<div className="npc-parallel-card">
			<header className="npc-parallel-heading"><div className="npc-parallel-mark" aria-hidden="true">润</div><div className="npc-parallel-title"><span className="npc-parallel-eyebrow">原稿之外 · 显示润色</span><h3>Veridis Rewrite</h3><p>完整作者交付后处理命中句子，不改原稿、变量、行动选项与剧情事实。</p></div></header>
			{loading && <div className="npc-parallel-feedback" role="status"><span className="npc-parallel-spinner" aria-hidden="true" />正在读取原版来源与设置状态…</div>}
			{error && <div className="npc-parallel-feedback is-error" role="alert"><p>{error}</p><button className="npc-parallel-button" type="button" disabled={loading || !!action} onClick={() => void reload()}>重新读取</button></div>}
			{!status && !loading && <p className="npc-parallel-inline-note">状态未知；尚不能确认安装、启用或模型配置。</p>}
			{status && <>
				<div className="npc-parallel-badges"><span>{status.installed ? `已校验 ${status.version ?? "版本未知"}` : "原版尚未安装"}</span><span className={status.enabled ? "is-on" : "is-muted"}>{status.enabled ? "已启用" : "已关闭"}</span></div>
				<div className="npc-parallel-info-grid"><div className="npc-parallel-info npc-parallel-info-wide"><span>独立模型岗位</span><strong>{status.model ? `${status.model.provider} / ${status.model.id}` : "未配置"}</strong><small>不借用正文作者；无规则命中不调用模型。</small></div></div>
				{busy && !action && <p className="npc-parallel-blocked" role="status">故事或插件任务正在进行，完成后可修改设置。</p>}
				{!status.model && <p className="npc-parallel-inline-note">启用前请配置独立模型岗位。已经启用的插件仍可关闭。</p>}
				{status.lastError && <p className="npc-parallel-feedback is-error" role="alert">上次更新未完成：{status.lastError}</p>}
				{status.receipt?.status === "failed" && <p className="npc-parallel-feedback is-error" role="alert">{status.receipt.error ?? "未提供失败原因，请核对本拍文字对照收据。"}</p>}
				{status.receipt && <div className="npc-parallel-receipt"><strong>本拍处理：{status.receipt.status === "complete" ? (status.receipt.changed ? "已生成润色显示稿" : "无措辞变化") : status.receipt.status === "skipped" ? (status.receipt.reason ?? "已跳过") : status.receipt.status === "failed" ? "失败，显示原稿" : `尚未确认完成（${status.receipt.status}）`}</strong><span>请求尝试 {status.receipt.calls} 次；不代表语义审阅通过。</span></div>}
				{status.candidateVersion && <p className="npc-parallel-candidate">候选 {status.candidateVersion} · {status.pendingActivation ? "待验收／待切换" : "尚未激活"}</p>}
				<div className="npc-parallel-actions">
					<button className="npc-parallel-button is-primary" type="button" disabled={blocked || !status.installed || !onOpenSettings} onClick={onOpenSettings}>打开原版工作台／上传规则</button>
					{!status.installed && <button className="npc-parallel-button" type="button" disabled={blocked} onClick={() => void run("install")}>安装原版</button>}
					<button className="npc-parallel-button" type="button" aria-pressed={status.enabled} disabled={blocked || (!status.enabled && (!status.installed || !status.model))} onClick={() => void run("config", "PUT", { enabled: !status.enabled })}>{status.enabled ? "关闭净化" : "启用净化"}</button>
					<button className="npc-parallel-button" type="button" aria-pressed={status.autoUpdate} disabled={blocked} onClick={() => void run("config", "PUT", { autoUpdate: !status.autoUpdate })}>自动更新：{status.autoUpdate ? "开启" : "关闭"}</button>
					<button className="npc-parallel-button" type="button" disabled={blocked} onClick={() => void run("check")}>检查更新</button>
					<button className="npc-parallel-button" type="button" disabled={blocked || !status.updateAvailable} onClick={() => void run("update")}>更新并验收</button>
					<button className="npc-parallel-button" type="button" disabled={blocked || !status.previousVersion} onClick={() => void run("rollback")}>回退上一版</button>
					<button className="npc-parallel-button" type="button" disabled={blocked} aria-expanded={editor} onClick={() => { if (editor && dirty && !window.confirm("放弃未保存的规则编辑并收起？")) return; setDraft(JSON.stringify(status.settings ?? {}, null, 2)); setDraftError(""); setDirty(false); setEditor(!editor); }}>宿主规则设置</button>
				</div>
			</>}
			{action && <p className="npc-parallel-feedback" role="status">正在{actionLabels[action]}，请稍候…</p>}
			{feedback && <p className="npc-parallel-feedback is-success" role="status">{feedback}</p>}
			{editor && <section className="plugin-rule-editor"><h4>高级规则 JSON {dirty && <small>· 未保存</small>}</h4><p>这是宿主规则入口，不是原版工作台。不得填入 API Key；模型由独立岗位管理。</p><textarea aria-label="Veridis Rewrite 宿主规则 JSON" value={draft} disabled={!!action || loading || storyBusy || !!status?.busy} onChange={event => { setDraft(event.target.value); setDirty(true); setDraftError(""); }} rows={12} spellCheck={false} />{draftError && <p role="alert">{draftError}</p>}<button className="npc-parallel-button" type="button" disabled={blocked} onClick={() => {
				try { const settings: unknown = JSON.parse(draft); if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(); setDraftError(""); void run("settings", "PUT", { settings }); }
				catch { setDraftError("规则 JSON 必须是有效对象，请修正后重试。"); }
			}}>保存规则设置</button></section>}
			<div className="npc-parallel-safety"><p>安装、启用和本拍处理是不同状态。失败、取消或来源过期时仍显示原稿。</p><p>原工作台保留规则导入与编辑；不开放历史改写、数据库净化或模型旁路。</p></div>
		</div>
	</article>;
}
