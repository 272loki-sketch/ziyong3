import { useCallback, useEffect, useRef, useState } from "react";
import "../npc-parallel.css";

type Toast = (level: "info" | "warning" | "error", text: string) => void;
type Receipt = { status: string; sourceEntryId: string; accepted: number; rejected: number; total: number; retained?: number; reason?: string };
export type NpcSidewriteSettings = {
	enabled: boolean; maxPerRound: number; cooldownRounds: number; minWords: number; maxWords: number;
	person: "third" | "first"; style: string; ignored: string[]; weights: Record<string, number>;
};
export type NpcSidewriteStatus = {
	implementation?: string; enabled: boolean; executionEnabled: boolean; ecologyEnabled: boolean; busy: boolean;
	model?: { provider: string; id: string }; scopeKey: string; sourceEntryId: string; revision: number;
	settings: NpcSidewriteSettings; receipt?: Receipt; requestBudget?: { used: number };
};
type Props = { contextTick: number; storyBusy?: boolean; toast?: Toast; onDirtyChange?: (dirty: boolean) => void };
type Feedback = { level: "success" | "error"; text: string } | null;

const STATUS_PATH = "/api/npc-parallel/status";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "众生侧写操作失败，请重试。";
}

async function readStatus(response: Response): Promise<NpcSidewriteStatus> {
	let data: unknown;
	try { data = await response.json(); } catch { throw new Error(`服务端返回了无法读取的状态（HTTP ${response.status}）`); }
	if (!response.ok) {
		const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : `请求失败（HTTP ${response.status}）`;
		throw new Error(message);
	}
	const s = data as NpcSidewriteStatus;
	if (!s || typeof s.enabled !== "boolean" || typeof s.busy !== "boolean" || !s.settings || typeof s.scopeKey !== "string"
		|| typeof s.sourceEntryId !== "string" || !Number.isInteger(s.revision)
		|| typeof s.settings.enabled !== "boolean" || typeof s.settings.style !== "string" || !Array.isArray(s.settings.ignored))
		throw new Error("服务端状态格式不完整；为安全起见，已禁用写操作。可重试读取。");
	return s;
}

function receiptLabel(status: string): string {
	return ({ accepted: "已采纳", rejected: "整批拒绝（业务审阅）", empty: "本拍无候选", failed: "生成／接入未完成" } as Record<string, string>)[status] ?? status;
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (next: boolean) => void }) {
	return <button type="button" className={`npc-parallel-switch${checked ? " is-on" : ""}`} role="switch"
		aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)}>
		<span aria-hidden="true" />
	</button>;
}

function NumberField({ label, value, min, max, hint, disabled, onChange }: { label: string; value: number; min: number; max: number; hint?: string; disabled: boolean; onChange: (n: number) => void }) {
	return <label className="npc-parallel-field"><span>{label}</span>
		<input type="number" inputMode="numeric" min={min} max={max} value={value} disabled={disabled}
			onChange={e => { const n = Math.floor(Number(e.target.value)); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); }} />
		{hint && <small>{hint}</small>}
	</label>;
}

export function NpcParallelPanel({ contextTick, storyBusy = false, toast, onDirtyChange }: Props) {
	const [status, setStatus] = useState<NpcSidewriteStatus | null>(null);
	const [draft, setDraft] = useState<NpcSidewriteSettings | null>(null);
	const [roster, setRoster] = useState<string[]>([]);
	const [statusError, setStatusError] = useState("");
	const [operation, setOperation] = useState("");
	const [feedback, setFeedback] = useState<Feedback>(null);
	const generation = useRef(0);
	const dirty = useRef(false);
	const writing = useRef(false);
	const currentContext = useRef(contextTick);
	currentContext.current = contextTick;
	const statusRef = useRef(status);
	statusRef.current = status;
	useEffect(() => { onDirtyChange?.(dirty.current || !!operation); }, [draft, operation, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	const refresh = useCallback(async () => {
		if (writing.current) return;
		const id = ++generation.current, tick = currentContext.current;
		const isCurrent = () => id === generation.current && tick === currentContext.current;
		try {
			const next = await readStatus(await fetch(STATUS_PATH, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) }));
			if (!isCurrent()) return;
			const previous = statusRef.current;
			if (dirty.current && previous && (previous.scopeKey !== next.scopeKey || previous.sourceEntryId !== next.sourceEntryId || previous.revision !== next.revision)) {
				setStatusError("服务端设置或来源已变化，草稿仍保留。请先放弃修改，再重新读取状态。");
				return;
			}
			setStatus(next); setStatusError("");
			if (!dirty.current) setDraft(next.settings);
			const r = await fetch("/api/npc-parallel/roster", { cache: "no-store", signal: AbortSignal.timeout(15_000) }).then(res => res.ok ? res.json() : { names: [] }).catch(() => ({ names: [] }));
			if (isCurrent()) setRoster(Array.isArray(r.names) ? r.names : []);
		} catch (error) { if (isCurrent()) setStatusError(errorText(error)); }
	}, []);

	useEffect(() => {
		writing.current = false;
		if (dirty.current) {
			setOperation(""); setFeedback(null);
			setStatusError("故事来源已变化，未保存的草稿仍保留。请先复制需要的内容，放弃修改后再读取当前设置。");
		} else {
			setStatus(null); setDraft(null); setRoster([]); setStatusError(""); setFeedback(null); setOperation("");
			void refresh();
		}
		const poll = window.setInterval(() => { if (!dirty.current) void refresh(); }, 12_000);
		return () => { generation.current++; window.clearInterval(poll); };
	}, [contextTick, refresh]);

	const write = async (label: string, path: string, payload: Record<string, unknown>, done: (s: NpcSidewriteStatus) => string) => {
		if (!status || writing.current || statusError || storyBusy || status.busy) return;
		writing.current = true;
		const id = ++generation.current, tick = contextTick;
		const isCurrent = () => id === generation.current && tick === currentContext.current;
		setOperation(label); setFeedback(null);
		try {
			const next = await readStatus(await fetch(path, { method: "PUT", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ ...payload, scopeKey: status.scopeKey, sourceEntryId: status.sourceEntryId, revision: status.revision }) }));
			if (!isCurrent()) return;
			if (next.scopeKey !== status.scopeKey || next.sourceEntryId !== status.sourceEntryId) throw new Error("保存返回的来源已变化，请重新读取状态。");
			setStatus(next);
			// A global switch does not save or discard the session editor.
			if (path.endsWith("/settings") || !dirty.current) { dirty.current = false; setDraft(next.settings); }
			const text = done(next); setFeedback({ level: "success", text }); toast?.("info", text);
		} catch (error) { if (isCurrent()) { const text = `${errorText(error)} 请重新读取状态核对，操作可能已提交。`; setStatusError(text); toast?.("error", text); } }
		finally { if (isCurrent()) { writing.current = false; setOperation(""); } }
	};

	const edit = (patch: Partial<NpcSidewriteSettings>) => { if (!draft) return; dirty.current = true; setDraft({ ...draft, ...patch }); };
	const toggleIgnored = (name: string) => { if (!draft) return; edit({ ignored: draft.ignored.includes(name) ? draft.ignored.filter(n => n !== name) : [...draft.ignored, name] }); };

	const busy = !!status?.busy || storyBusy;
	const locked = !status || !!operation || busy || !!statusError;
	const names = [...new Set([...roster, ...(draft?.ignored ?? [])])];

	return <section className="npc-parallel-panel" aria-label="众生侧写管理" aria-busy={!!operation}>
		<article className="npc-parallel-card">
			<header className="npc-parallel-heading">
				<div className="npc-parallel-mark" aria-hidden="true">众</div>
				<div className="npc-parallel-title"><span className="npc-parallel-eyebrow">鲜活世界 · 场外经历</span><h3>众生侧写</h3>
					<p>每拍正文定稿后，为镜头外的几位人物写下同一时间他们在做什么，交给鲜活世界核对与采纳。正文里与主角有交集的人物每拍必写一位。</p></div>
			</header>

			{statusError && <div className="npc-parallel-feedback is-error" role="alert"><p>状态读取失败：{statusError}</p>
				<button type="button" className="npc-parallel-button" onClick={() => void refresh()}>重试读取状态</button></div>}
			{!status && !statusError && <div className="npc-parallel-feedback" role="status"><span className="npc-parallel-spinner" aria-hidden="true" />正在读取众生侧写状态…</div>}

			{status && draft && <>
				<div className="npc-parallel-badges">
					<span className={status.enabled ? "is-on" : "is-muted"}>{status.enabled ? "模块已开启" : "模块已关闭"}</span>
					<span className={status.executionEnabled ? "is-on" : "is-muted"}>{status.executionEnabled ? "每拍后台自动运行" : "当前不会运行"}</span>
				</div>
				{busy && <div className="npc-parallel-inline-note" role="status">正在生成或后台整理；设置暂不可修改。</div>}

				<div className="npc-parallel-controls">
					<div className="npc-parallel-control-row">
						<div><strong>启用众生侧写</strong><p>依赖“鲜活世界”与独立模型岗位“众生侧写”；此处不会替你开启其它模块。</p></div>
						<Switch checked={status.enabled} disabled={locked || (!status.enabled && (!status.ecologyEnabled || !status.model))} label="众生侧写启用开关"
							onChange={enabled => void write("保存开关", "/api/npc-parallel/config", { enabled }, s => s.enabled ? "众生侧写已开启，下一拍起后台运行。" : "众生侧写已关闭，已有记录保留。")} />
					</div>
					{!status.ecologyEnabled && <div className="npc-parallel-blocked" role="note">无法开启：“鲜活世界”尚未启用。</div>}
					{status.ecologyEnabled && !status.model && <div className="npc-parallel-blocked" role="note">无法开启：请先在模型插头里配置“众生侧写”岗位。</div>}
				</div>

				<fieldset className="npc-parallel-settings">
					<legend>本会话设置</legend>
					<div className="npc-parallel-control-row">
						<div><strong>本会话运行</strong><p>只影响当前会话与角色卡。</p></div>
						<Switch checked={draft.enabled} disabled={locked} label="本会话运行众生侧写" onChange={enabled => edit({ enabled })} />
					</div>
					<div className="npc-parallel-field-grid">
						<NumberField label="每拍人数上限" value={draft.maxPerRound} min={0} max={24} hint="含必写的正文人物；0 = 不限" disabled={locked} onChange={maxPerRound => edit({ maxPerRound })} />
						<NumberField label="冷却轮数" value={draft.cooldownRounds} min={0} max={50} hint="最近写过的人降低入选概率" disabled={locked} onChange={cooldownRounds => edit({ cooldownRounds })} />
						<NumberField label="每人最少字数" value={draft.minWords} min={50} max={3000} disabled={locked} onChange={minWords => edit({ minWords, maxWords: Math.max(minWords, draft.maxWords) })} />
						<NumberField label="每人最多字数" value={draft.maxWords} min={draft.minWords} max={6000} disabled={locked} onChange={maxWords => edit({ maxWords })} />
						<label className="npc-parallel-field"><span>叙事人称</span>
							<select value={draft.person} disabled={locked} onChange={e => edit({ person: e.target.value === "first" ? "first" : "third" })}>
								<option value="third">第三人称</option><option value="first">第一人称</option>
							</select></label>
					</div>
					<label className="npc-parallel-field npc-parallel-field-wide"><span>写作要求</span>
						<textarea rows={6} value={draft.style} placeholder="留空使用内置要求：浅白短句、动作与对话为主、只写视角人物自己的内心、不复述正文。" disabled={!!operation || busy} readOnly={!!statusError}
							onChange={e => edit({ style: e.target.value })} /></label>
					{names.length > 0 && <div className="npc-parallel-roster" role="group" aria-label="参与侧写的人物">
						<span>参与人物（取消勾选即不再侧写）</span>
						<div>{names.map(name => <label key={name} className="npc-parallel-roster-item">
							<input type="checkbox" checked={!draft.ignored.includes(name)} disabled={locked} onChange={() => toggleIgnored(name)} />{name}
						</label>)}</div>
					</div>}
					<div className="npc-parallel-actions">
						<button type="button" className="npc-parallel-button is-primary" disabled={locked || !dirty.current}
							onClick={() => void write("保存设置", "/api/npc-parallel/settings", { settings: draft }, () => "侧写设置已保存。")}>{operation === "保存设置" ? "正在保存…" : "保存设置"}</button>
						<button type="button" className="npc-parallel-button" disabled={!!operation || !dirty.current} onClick={() => { dirty.current = false; setDraft(status.settings); if (statusError) void refresh(); }}>放弃修改</button>
						{dirty.current && <span className="npc-parallel-inline-note" role="status">有未保存的会话设置</span>}
					</div>
				</fieldset>

				<div className="npc-parallel-info-grid">
					<div className="npc-parallel-info"><span>独立模型岗位</span><strong>{status.model ? `${status.model.provider}/${status.model.id}` : "未配置"}</strong><small>与正文作者分开调用，每拍 1 次请求</small></div>
					{status.requestBudget && <div className="npc-parallel-info"><span>本来源请求累计</span><strong>{status.requestBudget.used} 次</strong></div>}
				</div>

				{status.receipt && <div className={`npc-parallel-receipt${status.receipt.status === "failed" ? " is-error" : ""}`} role={status.receipt.status === "failed" ? "alert" : "status"} aria-label="最近鲜活世界结算回执">
					<strong>最近一拍：{receiptLabel(status.receipt.status)}</strong>
					<span>候选 {status.receipt.total} · 已采纳 {status.receipt.accepted} · 未入账 {status.receipt.rejected}</span>
					{status.receipt.status === "failed" && <small>本批未提交，鲜活世界保留旧状态；可在正文下方的众生侧写卷宗里复用已有候选补办采纳。{status.receipt.reason ? `原因：${status.receipt.reason}` : ""}</small>}
				</div>}

				{operation && <div className="npc-parallel-feedback" role="status"><span className="npc-parallel-spinner" aria-hidden="true" />正在{operation}…</div>}
				{feedback && <div className={`npc-parallel-feedback ${feedback.level === "error" ? "is-error" : "is-success"}`} role={feedback.level === "error" ? "alert" : "status"}><p>{feedback.text}</p></div>}

				<div className="npc-parallel-safety">
					<p><strong>原文保护：</strong>侧写独立保存，不追加或改写主线原稿。</p>
					<p><strong>统一结算：</strong>侧写只是候选，由鲜活世界核对后才计入人物状态；未采纳的不当作已发生的事实。</p>
				</div>
			</>}
		</article>
	</section>;
}
