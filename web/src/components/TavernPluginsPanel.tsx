import { useCallback, useEffect, useRef, useState } from "react";
import { configureTavernPlugin, getTavernPluginsStatus, runTavernPluginAction, type TavernPluginAction, type TavernPluginId, type TavernPluginInfo, type TavernPluginsStatus } from "../api.ts";
import { IconBack, IconClose, IconRefresh, IconPuzzle, IconCheck } from "./icons.tsx";
import { Toggle } from "./kit.tsx";
import type { MvuSettingsTarget } from "./MvuPanel.tsx";
import "./TavernPluginsPanel.css";
import { PluginLeaveError, usePluginLeave } from "../plugins/usePluginLeave.tsx";

type Toast = (level: "info" | "warning" | "error", text: string) => void;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "酒馆插件操作失败";
const actionLabels: Record<TavernPluginAction, string> = { install: "安装原版", check: "检查更新", update: "更新并激活", rollback: "回退上一版" };

type OriginalSettingsProps = { plugin: TavernPluginInfo; contextTick?: number; onClose: () => void; presentation?: "modal" | "inline"; mvu?: MvuSettingsTarget };

/** Loads the unmodified upstream settings page and waits for its real host-ready state. */
export function OriginalTavernPluginManager({ plugin, contextTick = 0, onClose, presentation = "modal", mvu }: OriginalSettingsProps) {
	const rootRef = useRef<HTMLElement>(null);
	const { leave, pending: leaving, error: leaveError, discard } = usePluginLeave(rootRef, contextTick);
	const close = useRef(() => {});
	close.current = () => leave(onClose);
	const name=mvu?"MVU 变量框架":plugin.name,version=mvu?.version??plugin.version,commit=mvu?.commit??plugin.commit;
	const [attempt, setAttempt] = useState(0);
	const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
	const [frameError, setFrameError] = useState("");
	const frameRef = useRef<HTMLIFrameElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const inline = presentation === "inline";

	useEffect(() => {
		if (inline) { closeRef.current?.focus(); return; }
		const previous = document.activeElement;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
		};
		window.addEventListener("keydown", onKey);
		document.body.classList.add("tavern-plugins-manager-open");
		closeRef.current?.focus();
		return () => {
			window.removeEventListener("keydown", onKey);
			document.body.classList.remove("tavern-plugins-manager-open");
			if (previous instanceof HTMLElement && previous.isConnected && previous.offsetParent !== null) previous.focus();
		};
	}, [inline, onClose]);

	useEffect(() => {
		setPhase("loading"); setFrameError("");
		let active = true;
		let terminal = false;
		let documentObserver: MutationObserver | undefined;
		let statusObserver: MutationObserver | undefined;
		let missingStatusDeadline = 0;
		let readyDeadline = 0;
		let observedFrameDocument: Document | null = null;
		const frame = frameRef.current;
		const onEmbeddedKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
		};
		const stop = () => {
			terminal = true;
			documentObserver?.disconnect(); statusObserver?.disconnect();
			if (missingStatusDeadline) window.clearTimeout(missingStatusDeadline);
			if (readyDeadline) window.clearTimeout(readyDeadline);
		};
		const finish = (next: "ready" | "error", text = "") => {
			if (!active || terminal) return;
			stop(); setPhase(next); setFrameError(text);
		};
		const watch = () => {
			if (!active || terminal) return;
			try {
				const doc = frame?.contentDocument;
				if (!doc?.documentElement) return;
				const status = doc.getElementById("status");
				if (!status) {
					if (doc.readyState === "complete" && !missingStatusDeadline) {
						missingStatusDeadline = window.setTimeout(() => finish("error", "管理台文档未提供宿主状态标记，无法确认原插件已就绪。可重试或检查服务端兼容宿主。"), 15_000);
					}
					if (!documentObserver) {
						documentObserver = new MutationObserver(watch);
						documentObserver.observe(doc.documentElement, { childList: true, subtree: true });
					}
					return;
				}
				if (missingStatusDeadline) { window.clearTimeout(missingStatusDeadline); missingStatusDeadline = 0; }
				documentObserver?.disconnect(); documentObserver = undefined;
				const inspectStatus = () => {
					if (!active || terminal) return;
					const text = status.textContent?.trim() ?? "";
					if (/^原插件已就绪/.test(text)) finish("ready");
					else if (/原插件加载失败/.test(text)) finish("error", text);
				};
				inspectStatus();
				if (!terminal && !statusObserver) {
					statusObserver = new MutationObserver(inspectStatus);
					statusObserver.observe(status, { childList: true, characterData: true, subtree: true });
				}
			} catch { finish("error", "无法读取同源兼容宿主状态；为避免假报就绪，已停止显示原设置。请重试。"); }
		};
		const onLoad = () => {
			const next = frame?.contentDocument ?? null;
			if (next !== observedFrameDocument) {
				observedFrameDocument?.removeEventListener("keydown", onEmbeddedKeyDown, true);
				observedFrameDocument = next; observedFrameDocument?.addEventListener("keydown", onEmbeddedKeyDown, true);
			}
			watch();
		};
		frame?.addEventListener("load", onLoad);
		const onReadyMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || event.source !== frame?.contentWindow || event.data?.attempt !== String(attempt) || event.data?.contextTick !== String(contextTick)) return;
			if (event.data.type === "liyuan-tavern-manager-ready") { onLoad(); finish("ready"); }
			if (event.data.type === "liyuan-tavern-manager-error") finish("error", typeof event.data.error === "string" ? event.data.error : "原插件设置初始化失败");
		};
		window.addEventListener("message", onReadyMessage);
		readyDeadline = window.setTimeout(() => finish("error", "原插件管理台在60秒内没有报告就绪。当前插件版本未修改；可重试或检查服务端兼容宿主。"), 60_000);
		watch();
		return () => {
			active = false; stop(); frame?.removeEventListener("load", onLoad);
			window.removeEventListener("message", onReadyMessage);
            observedFrameDocument?.removeEventListener("keydown", onEmbeddedKeyDown, true);
            observedFrameDocument = null;
		};
	}, [attempt, contextTick, plugin.id, plugin.commit, mvu?.commit]);

	const retry = () => leave(() => { setPhase("loading"); setFrameError(""); setAttempt(value => value + 1); });
	const closeButton = inline
		? <button ref={closeRef} type="button" className="drawer-btn" onClick={() => close.current()}><IconBack size={15} /> 返回酒馆插件</button>
		: <button ref={closeRef} type="button" className="icon-btn" aria-label="关闭上游管理台" onClick={() => close.current()}><IconClose size={18} /></button>;
	const frame = <div className={`tavern-plugin-frame-wrap ${phase !== "ready" ? "is-not-ready" : ""}`}>
		<iframe
			ref={frameRef}
			key={`${plugin.id}:${plugin.commit ?? "unverified"}:${contextTick}:${attempt}`}
			title={`${name}原上游设置`}
			data-context-tick={contextTick}
			src={`/tavern-plugin-host.html?view=manager&plugin=${plugin.id}${mvu?"&focus=mvu":""}&attempt=${attempt}&contextTick=${contextTick}`}
			sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
			allow="clipboard-read; clipboard-write"
			onError={() => { setFrameError("原上游管理台页面未载入；服务端可能不可用。请重试。"); setPhase("error"); }}
			aria-hidden={phase !== "ready"}
			inert={phase !== "ready"}
		/>
		{phase !== "ready" && <div className={`tavern-plugin-frame-state ${phase === "error" ? "is-error" : ""}`} role={phase === "error" ? "alert" : "status"}>
			<strong>{phase === "loading" ? "正在验证原插件管理台…" : "原插件管理台未能打开"}</strong>
			{phase === "error" && <><span>{frameError}</span><button type="button" className="drawer-btn" onClick={retry}>重新载入并重试</button></>}
		</div>}
	</div>;

	const leaveFeedback = <>{leaving && <p role="status">正在等待原设置保存确认…</p>}<PluginLeaveError error={leaveError} discard={discard} /></>;
	if (inline) return <section ref={rootRef} className="tavern-plugin-original-inline" aria-label={`${name}原版设置`}>
		<header><div><h3>{name} · 原上游设置</h3><small>已核验 {version ?? "未知版本"} · {commit?.slice(0, 12) ?? "未知 commit"}</small></div>
			<div className="tavern-plugins-manager-actions">{closeButton}<button type="button" className="icon-btn" aria-label="重新载入上游管理台" onClick={retry}><IconRefresh size={17} /></button></div>
		</header>
		<p className="field-hint tavern-plugins-manager-note">原版插件运行文件保持不变；中文、主题与交互由梨园宿主适配。</p>
		{leaveFeedback}{frame}
	</section>;

	return <div className="tavern-plugins-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close.current(); }}>
		<section ref={rootRef} className="tavern-plugins-manager" role="dialog" aria-modal="true" aria-label={`${name}原上游管理台`}>
			<header><div><h3>{name} · 原上游管理台</h3><small>已核验 {version ?? "未知版本"} · {commit?.slice(0, 12) ?? "未知 commit"}</small></div>
				<div className="tavern-plugins-manager-actions">{closeButton}<button type="button" className="icon-btn" aria-label="重新载入上游管理台" onClick={retry}><IconRefresh size={17} /></button></div>
			</header>
			<p className="field-hint tavern-plugins-manager-note">原版插件运行文件保持不变；中文、主题与交互由梨园宿主适配。</p>
			{leaveFeedback}{frame}
		</section>
	</div>;
}

export function TavernPluginsPanel({ toast, contextTick = 0, managerMode = false, onOpenOriginal, pluginId, storyBusy = false }: {
	toast: Toast;
	contextTick?: number;
	managerMode?: boolean;
	pluginId?: TavernPluginId;
	storyBusy?: boolean;
	onOpenOriginal?: (plugin: TavernPluginInfo) => void;
}) {
	const [status, setStatus] = useState<TavernPluginsStatus | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [managerId, setManagerId] = useState<TavernPluginId | null>(null);
	const mounted = useRef(true);
	const request = useRef(0);
	const actionRunning = useRef(false);
	const refresh = useCallback(async (visible = false): Promise<TavernPluginsStatus> => {
		const token = ++request.current;
		if (visible && mounted.current) setLoading(true);
		try {
			const next = await getTavernPluginsStatus();
			if (mounted.current && token === request.current) { setStatus(next); setError(""); }
			return next;
		} catch (cause) {
			if (mounted.current && token === request.current) setError(messageOf(cause));
			throw cause;
		} finally { if (visible && mounted.current && token === request.current) setLoading(false); }
	}, []);
	useEffect(() => {
		mounted.current = true;
		void refresh(true).catch(() => {});
		const poll = window.setInterval(() => { if (!actionRunning.current) void refresh().catch(() => {}); }, 10_000);
		return () => { mounted.current = false; request.current++; window.clearInterval(poll); };
	}, [contextTick, refresh]);
	const operate = async (id: TavernPluginId, fn: () => Promise<unknown>, text: string, activation = false) => {
		if (actionRunning.current) return;
		actionRunning.current = true; setBusy(true);
		try {
			await fn();
			window.dispatchEvent(new CustomEvent("liyuan:tavern-plugins-changed", { detail: { id } }));
			try {
				const next = await refresh(true);
				const plugin = next.plugins.find((item) => item.id === id);
				if (activation && plugin?.pendingActivation) toast("warning", "原文件候选已缓存，宿主忙碌时不会切换；等待空闲与原插件实测校验后激活。");
				else toast("info", text);
			} catch (cause) {
				const message = messageOf(cause);
				if (mounted.current) setError(`操作已提交，但插件状态刷新失败：${message}`);
				toast("warning", `操作已提交；状态刷新失败，可点击“重新读取插件状态”重试：${message}`);
			}
		} catch (cause) {
			const message = messageOf(cause);
			if (mounted.current) setError(message);
			toast("error", message);
		} finally { actionRunning.current = false; if (mounted.current) setBusy(false); }
	};
	const closeManager = useCallback(() => setManagerId(null), []);
	const openOriginal = async (plugin: TavernPluginInfo) => {
		if (actionRunning.current) return;
		actionRunning.current = true; setBusy(true);
		try {
			const current = await refresh(true);
			const verified = current.plugins.find(item => item.id === plugin.id);
			if (!verified?.installed) throw new Error(`${plugin.name}当前未安装或完整性校验失败，未打开管理台。`);
			if (onOpenOriginal) onOpenOriginal(verified); else setManagerId(verified.id);
		} catch (cause) { toast("error", messageOf(cause)); }
		finally { actionRunning.current = false; if (mounted.current) setBusy(false); }
	};
	const managerPlugin = status?.plugins.find((plugin) => plugin.id === managerId);
	const disabled = busy || loading || !!error || storyBusy || !!status?.checking;
	return <section className={`sp-section tavern-plugins-panel ${managerMode ? "is-manager" : ""}`} aria-busy={loading || busy}>
		{!managerMode && <h4>酒馆助手与提示词模板 · 原版接入</h4>}
		<p className="tavern-plugins-intro">管理角色卡的渲染、脚本与模板功能。安装和开启分开进行，原数据始终保留。</p>
		{storyBusy && <p role="status" className="plugin-center-footnote">故事正在生成或后台整理，完成后可修改插件设置。</p>}
		{error && status && <div className="panel-error tavern-plugin-status-error" role="alert">状态刷新失败：{error}<button type="button" className="drawer-btn" disabled={busy} onClick={() => void refresh(true).catch(() => {})}>重试读取状态</button></div>}
		{!status ? loading ? <div className="tavern-plugins-loading" role="status">正在读取原插件安装与完整性状态…</div> : <div className="tavern-plugin-empty-state"><p role="alert">无法读取酒馆插件状态{error ? `：${error}` : ""}</p><button type="button" className="drawer-btn" disabled={busy || loading} onClick={() => void refresh(true).catch(() => {})}>重新读取插件状态</button></div> : <>
			<div className="tavern-plugin-grid">{status.plugins.filter(plugin => !pluginId || plugin.id === pluginId).map((plugin) => <article className={`tavern-plugin-card ${managerMode ? "tavern-plugin-card-manager" : ""}`} key={plugin.id} aria-label={`${plugin.name}来源与更新`}>
				<div className="tavern-plugin-heading">
					<span className="tavern-plugin-symbol" aria-hidden="true"><IconPuzzle size={23} /></span>
					<div className="tavern-plugin-title"><strong>{plugin.name}</strong><p>{plugin.id === "helper" ? "HTML 渲染 · 脚本 · 变量管理" : "EJS 求值 · 提示词注入 · 消息模板"}</p></div>
				</div>
				<div className="tavern-plugin-badges"><span className={plugin.installed ? "is-verified" : "is-missing"}>{plugin.installed && <IconCheck size={13} />}{plugin.installed ? `已校验 ${plugin.version ?? "未知版本"}` : "尚未安装或完整性失败"}</span><span className={plugin.enabled ? "is-enabled" : "is-disabled"}>{plugin.enabled ? "已启用" : "未启用"}</span></div>
				<div className="tavern-plugin-preferences">
				<div className="toggle-row"><span><strong>启用 {plugin.name}</strong><small>关闭后保留插件设置与已有数据</small></span><Toggle title={`启用 ${plugin.name}`} checked={plugin.enabled} disabled={disabled || (!plugin.installed && !plugin.enabled)} onChange={(enabled) => void operate(plugin.id, () => configureTavernPlugin(plugin.id, { enabled }), enabled ? `${plugin.name}已明确启用` : `${plugin.name}已关闭，原数据保留`)} /></div>
				<div className="toggle-row"><span><strong>自动更新</strong><small>校验原文件，仅在宿主空闲时激活</small></span><Toggle title={`${plugin.name}自动更新`} checked={plugin.autoUpdate} disabled={disabled} onChange={(autoUpdate) => void operate(plugin.id, () => configureTavernPlugin(plugin.id, { autoUpdate }), autoUpdate ? "已开启原插件自动更新" : "已关闭自动更新，当前固定版本保留")} /></div>
				</div>
				<button type="button" className="drawer-btn tavern-plugin-open-original" disabled={disabled || !plugin.installed} onClick={() => void openOriginal(plugin)}>{managerMode ? `打开${plugin.name}原设置` : "打开上游管理台"}<span aria-hidden="true">↗</span></button>
				{plugin.commit && <details className="tavern-plugin-integrity"><summary>完整性与更新记录</summary><dl><dt>固定 commit</dt><dd>{plugin.commit}</dd><dt>文件清单 SHA-256</dt><dd>{plugin.sha256 ?? "—"}</dd><dt>上一版本</dt><dd>{plugin.previousVersion ?? "尚无"}</dd><dt>最后检查</dt><dd>{plugin.lastCheck ?? "尚未检查"}</dd></dl></details>}
				{plugin.updateAvailable && <div className="field-hint">候选 {plugin.candidateVersion ?? "新版本"}{plugin.pendingActivation ? "已缓存，等待安全激活" : "待检查/手动重试"}；当前已激活版本不因忙碌或验证失败被替换。</div>}
				{plugin.lastError && <div className="panel-error" role="alert">{plugin.lastError}</div>}
				<div className="panel-row tavern-plugin-buttons">{(["install", "check", "update", "rollback"] as const).map((action) => <button type="button" className="drawer-btn" key={action} disabled={disabled || (action === "rollback" && !plugin.previousVersion)} onClick={() => void operate(plugin.id, () => runTavernPluginAction(action, plugin.id), action === "check" ? "上游检查与候选原文件校验已完成；当前版本未切换" : `${plugin.name}${actionLabels[action]}操作已完成`, action === "install" || action === "update")}>{actionLabels[action]}</button>)}
				</div>
			</article>)}</div>
			{status.checking && <div className="field-hint" role="status">正在检查/校验原插件；已激活原文件保持不变。</div>}
		</>}
		<details className="tavern-plugins-safety"><summary>原版来源与安全说明</summary><p>仅加载两个固定上游仓库的原始运行文件，不修改或重编上游代码。安装不会自动启用，也不会覆盖模型、角色卡或其他配置。</p><p>自动更新默认开启：逐文件校验并实测候选，等待宿主空闲后才激活；保留上一版可回退。梨园只适配已支持的酒馆宿主能力，不代表完整酒馆。</p></details>
		{!managerMode && managerPlugin?.installed && <OriginalTavernPluginManager key={`${managerPlugin.id}:${managerPlugin.commit}:${contextTick}`} plugin={managerPlugin} contextTick={contextTick} onClose={closeManager} />}
	</section>;
}
