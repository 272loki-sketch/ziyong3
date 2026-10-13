import { useCallback, useEffect, useRef, useState } from "react";
import "../npc-parallel.css";
import { PluginLeaveError, usePluginLeave } from "../plugins/usePluginLeave.tsx";

type Toast = (level: "info" | "warning" | "error", text: string) => void;
type Receipt = { status: string; sourceEntryId: string; accepted: number; rejected: number; total: number };
type NpcParallelStatus = {
 scopeKey?:string;sourceEntryId?:string;revision?:number;upstreamCommit?:string;
	installed: boolean;
	enabled: boolean;
	autoTrigger?: boolean;
	executionEnabled?: boolean;
	executionReason?: string;
	autoUpdate: boolean;
	version?: string;
	previousVersion?: string;
	source?: { previousVersion?: string };
	commit?: string;
	sha256?: string;
	candidateVersion?: string;
	updateAvailable?: boolean;
	pendingActivation?: boolean;
	lastError?: string;
	busy: boolean;
	ecologyEnabled: boolean;
	model?: { provider: string; id: string };
	receipt?: Receipt;
};
type Props = { contextTick: number; storyBusy?: boolean; toast?: Toast; onOpenSettings?: () => void };
type Action = "install" | "check" | "update" | "rollback";
type Feedback = { level: "success" | "error"; text: string } | null;

const STATUS_PATH = "/api/npc-parallel/status";
const actionText: Record<Action, string> = {
	install: "安装原版",
	check: "检查更新",
	update: "更新并激活",
	rollback: "回退上一版",
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "众生侧写操作失败，请重试。";
}

async function readStatus(response: Response): Promise<NpcParallelStatus> {
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error(`服务端返回了无法读取的状态（HTTP ${response.status}）`);
	}
	if (!response.ok) {
		const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
			? data.error
			: `请求失败（HTTP ${response.status}）`;
		throw new Error(message);
	}
	if (!data || typeof data !== "object" || typeof (data as NpcParallelStatus).installed !== "boolean"
		|| typeof (data as NpcParallelStatus).enabled !== "boolean"
		|| typeof (data as NpcParallelStatus).autoUpdate !== "boolean"
		|| typeof (data as NpcParallelStatus).busy !== "boolean"
		|| typeof (data as NpcParallelStatus).ecologyEnabled !== "boolean") {
		throw new Error("服务端状态格式不完整；为安全起见，已禁用写操作。可重试读取。");
	}
	return data as NpcParallelStatus;
}

async function fetchStatus(): Promise<NpcParallelStatus> {
	return readStatus(await fetch(STATUS_PATH, { headers: { accept: "application/json" }, cache: "no-store" }));
}

function feedbackTextForAction(action: Action, status: NpcParallelStatus): string {
	if (action === "install") return status.installed
		? `原版已安装（${status.version ?? "版本未知"}）；安装不会自动启用。`
		: "安装请求已返回，但服务端尚未确认原版安装完成。";
	if (action === "check") return status.updateAvailable
		? `已发现候选 ${status.candidateVersion ?? "新版本"}；候选尚不等于已更新。`
		: "检查完成，未发现可用更新；当前激活版本未切换。";
	if (action === "update" && status.pendingActivation) {
		return `候选 ${status.candidateVersion ?? "新版本"} 已暂存，等待空闲切换；当前激活版本仍为 ${status.version ?? "未知版本"}。`;
	}
	if (action === "update") return `更新操作已返回；当前服务端版本为 ${status.version ?? "未知版本"}。`;
	return `回退操作已返回；当前服务端版本为 ${status.version ?? "未知版本"}。`;
}

function receiptLabel(status: string): string {
	const labels: Record<string, string> = {
		accepted: "整批采纳",
		rejected: "整批拒绝（业务审阅）",
		empty: "无候选",
		failed: "审阅或结算失败",
	};
	return labels[status] ?? status;
}

function Switch({ checked, disabled, label, onChange }: {
	checked: boolean;
	disabled: boolean;
	label: string;
	onChange: (next: boolean) => void;
}) {
	return <button type="button" className={`npc-parallel-switch${checked ? " is-on" : ""}`} role="switch"
		aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={() => onChange(!checked)}>
		<span aria-hidden="true" />
	</button>;
}

export function NpcParallelOriginalSettings({ theme, contextTick, onBack, embedded = false }: { theme: "light" | "dark"; contextTick: number; onBack: () => void; embedded?: boolean }) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const managerRef = useRef<HTMLDivElement>(null);
	const { leave, pending: leaving, error: leaveError, discard } = usePluginLeave(managerRef, contextTick);
	const [attempt, setAttempt] = useState(0);
	const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
	const [problem, setProblem] = useState("");
	const onBackRef = useRef(onBack);
	onBackRef.current = () => leave(onBack);

	useEffect(() => {
		let active = true;
		let ready = false;
		let timer = 0;
		let deadline = 0;
		let observedDocument: Document | null = null;
		const frame = frameRef.current;
		setPhase("loading");
		setProblem("");
		const finishReady = () => {
			if (!active || ready) return;
			ready = true;
			window.clearTimeout(deadline);
			window.clearInterval(timer);
			setPhase("ready");
		};
		const onFrameKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (frame?.contentDocument?.querySelector("dialog[open]")) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				onBackRef.current();
			}
		};
		const inspectReady = () => {
			if (!active || ready) return;
			try {
				const host = frame?.contentWindow as (Window & { LiyuanNpcParallel?: { ready?: boolean | (() => boolean) } }) | null | undefined;
				if (!host) return;
				const flag = host.LiyuanNpcParallel?.ready;
				if (typeof flag === "function" ? flag() : flag === true) finishReady();
			} catch {
				if (active && !ready) {
					setProblem("无法读取同源原版设置页；梨园未将其误报为就绪。请检查宿主地址后重试。");
					setPhase("error");
					window.clearTimeout(deadline);
					window.clearInterval(timer);
				}
			}
		};
		const onFrameLoad = () => {
			if (!active) return;
			try {
				const nextDocument = frame?.contentDocument ?? null;
				if (observedDocument !== nextDocument) {
					observedDocument?.removeEventListener("keydown", onFrameKeyDown, true);
					observedDocument = nextDocument;
					observedDocument?.addEventListener("keydown", onFrameKeyDown, true);
				}
				// A document load is not proof that the plugin runtime is ready.
				inspectReady();
			} catch {
				setProblem("原版设置页无法由梨园同源宿主读取；请重试或检查服务端。");
				setPhase("error");
				window.clearTimeout(deadline);
				window.clearInterval(timer);
			}
		};
		const onFrameError = () => {
			if (!active || ready) return;
			setProblem("原版设置页加载失败；梨园状态与原插件数据未被修改。请重试。");
			setPhase("error");
			window.clearTimeout(deadline);
			window.clearInterval(timer);
		};
		const onReadyMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || event.source !== frame?.contentWindow) return;
			if (event.data?.type === "liyuan:npc-parallel-ready") finishReady();
			else if (event.data?.type === "liyuan:npc-parallel-error" && !ready) {
				setProblem(typeof event.data.error === "string" ? event.data.error : "原版设置初始化失败，未将部分控件误报为就绪。");
				setPhase("error"); window.clearTimeout(deadline); window.clearInterval(timer);
			}
		};
		const onParentKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				onBackRef.current();
			}
		};
		frame?.addEventListener("load", onFrameLoad);
		frame?.addEventListener("error", onFrameError);
		// Also inspect the current document in case the iframe's first load beat this effect.
		onFrameLoad();
		window.addEventListener("message", onReadyMessage);
		window.addEventListener("keydown", onParentKeyDown, true);
		timer = window.setInterval(inspectReady, 150);
		deadline = window.setTimeout(() => {
			if (!active || ready) return;
			setProblem("原版设置页已载入，但 20 秒内没有报告运行就绪。页面加载不代表插件已就绪；可重试或检查兼容宿主。");
			setPhase("error");
			window.clearInterval(timer);
		}, 20_000);
		return () => {
			active = false;
			window.clearTimeout(deadline);
			window.clearInterval(timer);
			frame?.removeEventListener("load", onFrameLoad);
			frame?.removeEventListener("error", onFrameError);
			window.removeEventListener("message", onReadyMessage);
			window.removeEventListener("keydown", onParentKeyDown, true);
			observedDocument?.removeEventListener("keydown", onFrameKeyDown, true);
			observedDocument = null;
		};
	}, [attempt, contextTick, theme]);

	const retry = () => {
		leave(() => {
		setPhase("loading");
		setProblem("");
		setAttempt(value => value + 1);
		});
	};
	const src = `/npc-parallel-host.html?view=manager&theme=${theme}`;
	return <div ref={managerRef} className={`npc-parallel-manager${embedded ? " is-embedded" : ""}`} role="region" aria-label="众生侧写原版设置">
		<header className="npc-parallel-manager-header">
			<div><span className="npc-parallel-eyebrow">原版管理页</span><h3>众生侧写设置</h3><p>梨园宿主适配页 · 不改写主线原稿</p></div>
			<div className="npc-parallel-manager-actions">
				<button type="button" className="npc-parallel-button" disabled={leaving} onClick={() => leave(onBack)}>返回梨园管理</button>
				<button type="button" className="npc-parallel-button npc-parallel-icon-button" aria-label="重新载入原版设置" title="重新载入原版设置" onClick={retry}>↻</button>
			</div>
		</header>
		{leaving && <p role="status">正在等待原设置保存确认…</p>}
		<PluginLeaveError error={leaveError} discard={discard} />
		<div className={`npc-parallel-frame-wrap${phase !== "ready" ? " is-not-ready" : ""}`}>
			<iframe ref={frameRef} key={attempt} title="众生侧写原版设置" src={`${src}&attempt=${attempt}&contextTick=${encodeURIComponent(String(contextTick))}`}
				sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" aria-hidden={phase !== "ready"} />
			{phase !== "ready" && <div className={`npc-parallel-frame-state${phase === "error" ? " is-error" : ""}`} role={phase === "error" ? "alert" : "status"}>
				<strong>{phase === "loading" ? "正在等待原版插件报告就绪…" : "原版设置尚未就绪"}</strong>
				{phase === "error" && <><span>{problem}</span><button type="button" className="npc-parallel-button" onClick={retry}>重新载入并重试</button></>}
			</div>}
		</div>
	</div>;
}

export function NpcParallelPanel({ contextTick, storyBusy = false, toast, onOpenSettings }: Props) {
	const [status, setStatus] = useState<NpcParallelStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [statusError, setStatusError] = useState("");
	const [operation, setOperation] = useState("");
	const [feedback, setFeedback] = useState<Feedback>(null);
	const [managerOpen, setManagerOpen] = useState(false);
	const [managerTheme, setManagerTheme] = useState<"light" | "dark">("light");
	const requestId = useRef(0);
	const operationRunning = useRef(false);
	const mounted = useRef(false);
	const hasStatus = useRef(false);

	const refresh = useCallback(async (visible = false): Promise<NpcParallelStatus> => {
		const id = ++requestId.current;
		if (visible && mounted.current) {
			if (!hasStatus.current) setLoading(true);
			setRefreshing(true);
		}
		try {
			const next = await fetchStatus();
			if (mounted.current && id === requestId.current) {
				hasStatus.current = true;
				setStatus(next);
				setStatusError("");
			}
			return next;
		} catch (error) {
			if (mounted.current && id === requestId.current) setStatusError(errorText(error));
			throw error;
		} finally {
			if (mounted.current && id === requestId.current) {
				setLoading(false);
				setRefreshing(false);
			}
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh(true).catch(() => {});
		const poll = window.setInterval(() => {
			if (!operationRunning.current) void refresh(false).catch(() => {});
		}, 12_000);
		return () => {
			mounted.current = false;
			requestId.current++;
			window.clearInterval(poll);
		};
	}, [contextTick, refresh]);

	const notify = (level: "info" | "warning" | "error", text: string) => {
		toast?.(level, text);
	};
	const runOperation = async (label: string, request: () => Promise<NpcParallelStatus>, success: (next: NpcParallelStatus) => string) => {
		if (operationRunning.current) return;
		operationRunning.current = true;
		requestId.current++;
		setOperation(label);
		setFeedback(null);
		try {
			const next = await request();
			if (mounted.current) {
				setStatus(next);
				setStatusError("");
				const text = success(next);
				setFeedback({ level: "success", text });
				notify(next.lastError ? "warning" : "info", next.lastError ? `${text} ${next.lastError}` : text);
			}
		} catch (error) {
			const text = errorText(error);
			if (mounted.current) setFeedback({ level: "error", text });
			notify("error", text);
		} finally {
			operationRunning.current = false;
			if (mounted.current) setOperation("");
		}
	};
	const config = (body: { enabled?: boolean; autoUpdate?: boolean }) => runOperation(
		"保存设置",
		async () => readStatus(await fetch("/api/npc-parallel/config", {
			method: "PUT",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({...body,scopeKey:status?.scopeKey,sourceEntryId:status?.sourceEntryId,revision:status?.revision,upstreamCommit:status?.upstreamCommit}),
		})),
		next => body.enabled === undefined
			? `自动更新已${next.autoUpdate ? "开启" : "关闭"}。`
			: next.enabled ? "众生侧写原版开关已开启；是否自动执行以服务端 executionEnabled 为准，不代表本拍已采纳。" : "众生侧写原版开关已关闭，已有资料保留。",
	);
	const action = (name: Action) => runOperation(
		actionText[name],
		async () => readStatus(await fetch(`/api/npc-parallel/${name}`, {
			method: "POST",
			headers: { accept: "application/json", "content-type":"application/json" },
            body:JSON.stringify({scopeKey:status?.scopeKey,sourceEntryId:status?.sourceEntryId,revision:status?.revision,upstreamCommit:status?.upstreamCommit}),
		})),
		next => feedbackTextForAction(name, next),
	);
	const retryStatus = () => {
		setFeedback(null);
		void refresh(true).then(next => {
			const text = `状态已重新读取：${next.installed ? `已安装 ${next.version ?? "版本未知"}` : "尚未安装"}。`;
			setFeedback({ level: "success", text });
		}).catch(error => {
			const text = errorText(error);
			setFeedback({ level: "error", text });
		});
	};

	const baseUnavailable = !status || loading || refreshing || !!statusError || !!operation;
	const serverBusy = !!status?.busy || storyBusy;
	const previousVersion = status?.source?.previousVersion ?? status?.previousVersion;
	const installDisabled = baseUnavailable || serverBusy || !!status?.installed;
	const enableDisabled = baseUnavailable || serverBusy || (!status?.installed && !status?.enabled)
		|| (!status?.enabled && !status?.ecologyEnabled);
	const autoUpdateDisabled = baseUnavailable || serverBusy || !status?.installed;
	const checkDisabled = baseUnavailable || !status?.installed;
	const activationDisabled = baseUnavailable || serverBusy || !status?.installed || !status?.updateAvailable || !!status?.pendingActivation;
	const rollbackDisabled = baseUnavailable || serverBusy || !status?.installed || !previousVersion;
	if (managerOpen) return <section className="npc-parallel-panel" aria-label="众生侧写管理">
		<NpcParallelOriginalSettings theme={managerTheme} contextTick={contextTick} onBack={() => setManagerOpen(false)} />
	</section>;

	return <section className="npc-parallel-panel" aria-label="众生侧写管理" aria-busy={loading || !!operation}>
		<article className="npc-parallel-card">
			<header className="npc-parallel-heading">
				<div className="npc-parallel-mark" aria-hidden="true">众</div>
				<div className="npc-parallel-title"><span className="npc-parallel-eyebrow">鲜活世界 · 场外经历</span><h3>众生侧写</h3><p>由原版插件生成镜头外人物经历，交由鲜活世界统一核对与采纳。</p></div>
		</header>

		{statusError && <div className="npc-parallel-feedback is-error" role="alert">
			<p>状态读取失败：{statusError}</p><button type="button" className="npc-parallel-button" disabled={refreshing} onClick={retryStatus}>重试读取状态</button>
		</div>}
		{!status && loading && <div className="npc-parallel-feedback" role="status"><span className="npc-parallel-spinner" aria-hidden="true" />正在读取众生侧写状态…</div>}
		{status && <>
			<div className="npc-parallel-badges">
				<span className={status.installed ? "is-ok" : "is-muted"}>{status.installed ? `已安装 ${status.version ?? "版本未知"}` : "尚未安装"}</span>
				<span className={status.enabled ? "is-on" : "is-muted"}>{status.enabled ? "原版开关已开启" : "原版开关已关闭"}</span>
				<span className={status.executionEnabled === true ? "is-on" : "is-muted"}>{status.executionEnabled === true ? "后台自动执行已启用" : status.executionEnabled === false ? "后台自动执行已停用" : "后台执行状态未提供"}</span>
			</div>
			{status.executionReason && <div className="npc-parallel-inline-note" role="status">自动执行原因：{status.executionReason}</div>}
			{status.autoTrigger === false && !status.executionReason && <div className="npc-parallel-inline-note" role="status">原插件 autoTrigger=false；原版开关开启不代表自动触发。</div>}
			{status.busy && <div className="npc-parallel-inline-note" role="status">插件宿主正在处理任务；启停、更新与回退暂不可用。检查更新仍可尝试。</div>}
			{storyBusy && <div className="npc-parallel-inline-note" role="status">梨园当前正在生成故事；已暂停插件启停、安装、更新与回退操作。</div>}
			{status.lastError && <div className="npc-parallel-feedback is-error" role="alert">服务端提示：{status.lastError}</div>}

			<div className="npc-parallel-controls">
				<div className="npc-parallel-control-row">
					<div><strong>原版插件开关</strong><p>这是来源启用状态；自动运行另看 executionEnabled / executionReason。</p></div>
					<Switch checked={status.enabled} disabled={enableDisabled} label="众生侧写原版插件启用开关" onChange={enabled => void config({ enabled })} />
				</div>
				{!status.ecologyEnabled && <div className="npc-parallel-blocked" role="note">无法开启：梨园“鲜活世界”尚未启用。请在梨园对应设置中单独开启；此面板不会替你开启其他模块。</div>}
				<div className="npc-parallel-control-row">
					<div><strong>自动更新</strong><p>候选先验收，通过后仅在梨园空闲时切换；待验证或待切换不等于已更新。</p></div>
					<Switch checked={status.autoUpdate} disabled={autoUpdateDisabled} label="众生侧写自动更新" onChange={autoUpdate => void config({ autoUpdate })} />
				</div>
			</div>

			<div className="npc-parallel-info-grid">
				<div className="npc-parallel-info"><span>鲜活世界依赖</span><strong className={status.ecologyEnabled ? "is-ok" : "is-muted"}>{status.ecologyEnabled ? "已开启" : "未开启"}</strong></div>
				<div className="npc-parallel-info"><span>独立模型岗位</span><strong>{status.model?.id ?? "未提供"}</strong><small>与正文作者分开调用</small></div>
				{status.model && <div className="npc-parallel-info npc-parallel-info-wide"><span>服务端报告模型</span><strong>{status.model.provider}/{status.model.id}</strong></div>}
			</div>

			{status.receipt && <div className={`npc-parallel-receipt${status.receipt.status === "failed" ? " is-error" : ""}`} role={status.receipt.status === "failed" ? "alert" : "status"} aria-label="最近鲜活世界结算回执">
				<strong>最近鲜活世界回执：{receiptLabel(status.receipt.status)}</strong>
				<span>采纳 {status.receipt.accepted} · 拒绝 {status.receipt.rejected} · 共 {status.receipt.total}</span>
				{status.receipt.status === "rejected" && <small>这是正常业务拒绝：本批候选未入账，原生态状态保持不变。</small>}
				{status.receipt.status === "empty" && <small>本拍没有可供统一审阅的侧写候选。</small>}
				{status.receipt.status === "failed" && <small>本批未提交；鲜活世界保留旧状态。请查看梨园任务错误并稍后重试。</small>}
				<small>来源正文条目：{status.receipt.sourceEntryId}</small>
			</div>}

			{(status.updateAvailable || status.pendingActivation) && <div className={`npc-parallel-candidate${status.pendingActivation ? " is-pending" : ""}`} role="status">
				<strong>{status.pendingActivation ? "候选已暂存，等待空闲切换" : "发现候选，尚未成为当前版本"}</strong>
				<span>候选版本 {status.candidateVersion ?? "待确认"} · 当前版本 {status.version ?? "未安装"}</span>
			</div>}
			{status.commit && <details className="npc-parallel-integrity"><summary>版本与完整性</summary><dl>
				<div><dt>当前 commit</dt><dd>{status.commit}</dd></div>
				<div><dt>上一版本</dt><dd>{previousVersion ?? "暂无可回退版本"}</dd></div>
				<div><dt>文件清单 SHA-256</dt><dd>{status.sha256 ?? "—"}</dd></div>
			</dl></details>}

			{operation && <div className="npc-parallel-feedback" role="status"><span className="npc-parallel-spinner" aria-hidden="true" />正在{operation}，请稍候…</div>}
			{feedback && <div className={`npc-parallel-feedback ${feedback.level === "error" ? "is-error" : "is-success"}`} role={feedback.level === "error" ? "alert" : "status"}><p>{feedback.text}</p></div>}

			<div className="npc-parallel-actions">
				{!status.installed && <button type="button" className="npc-parallel-button is-primary" disabled={installDisabled} onClick={() => void action("install")}>{operation === "安装原版" ? "正在安装…" : "显式安装原版"}</button>}
				<button type="button" className="npc-parallel-button" disabled={checkDisabled} onClick={() => void action("check")}>{operation === "检查更新" ? "正在检查…" : "检查更新"}</button>
				<button type="button" className="npc-parallel-button" disabled={activationDisabled} onClick={() => void action("update")}>{operation === "更新并激活" ? "正在更新…" : "更新并激活"}</button>
				<button type="button" className="npc-parallel-button" disabled={rollbackDisabled} title={!previousVersion ? "服务端尚无上一版本可回退" : undefined} onClick={() => void action("rollback")}>{operation === "回退上一版" ? "正在回退…" : "回退上一版"}</button>
				{status.installed && !previousVersion && <span className="npc-parallel-action-hint">暂无上一版本，暂不可回退。</span>}
				{status.installed && <button type="button" className="npc-parallel-button is-secondary" disabled={baseUnavailable} onClick={() => { setManagerTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"); if (onOpenSettings) onOpenSettings(); else setManagerOpen(true); }}>打开原版设置</button>}
			</div>

			<div className="npc-parallel-safety">
				<p><strong>原文保护：</strong>侧写独立保存，不追加或改写主线原稿。</p>
				<p><strong>统一结算：</strong>场外候选由鲜活世界核对、记录采纳结果；未经采纳的候选不作为已确认事实。</p>
				<p><strong>能力边界：</strong>这是梨园适配的宿主，不是完整酒馆环境；原设置页的手动生成在宿主中禁用。来源开关不代表自动运行，实际执行状态以服务端回报为准。</p>
			</div>
		</>}
		{loading && status && <div className="npc-parallel-refreshing" role="status">正在刷新服务端状态…</div>}
	</article>
	</section>;
}
