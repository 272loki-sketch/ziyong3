import { workspaceFrameBootstrap } from "../workspace.ts";
/**
 * 对话流 HTML 沙箱帧（底层展示通道）。
 *
 * - 默认：sandbox 禁止脚本（静态 HTML/CSS）
 * - scripts=true：allow-scripts，仍无 allow-same-origin → 无法读写父页面
 * - seamless=true：无痕模式（卡皮肤/整楼界面）——幽灵操作、真实高度、样式主权
 * - 与侧栏 ArtifactPanel 锁死策略不同：此处按消息/工具显式开关脚本，服务「中途渲染 UI」
 *
 * 视口接管型程序卡（某卡、某卡开局创建器等）UI 是 fixed/100% 铺满。
 * 若初始 iframe 只有 minHeight(120)，量高永远量出 120 → 按钮被裁切在框外 → 用户感觉「点了没反应」。
 * 接管型：按视口锁高、不注入上报器、不收内容量高消息——内容量高与卡内
 * ResizeObserver 互踩会形成「收拢/涨高」乒乓（某卡开局创建器持续抖动事故）。
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { buildSrcDoc, looksLikeProgramApp, programViewportHeight } from "../frameDoc.ts";

export { looksLikeProgramApp, programViewportHeight } from "../frameDoc.ts";

export function HtmlFrame({
	html,
	title,
	scripts = false,
	seamless = false,
	minHeight = 120,
	maxHeight = 560,
	collapsible = false,
	defaultOpen = true,
	variables,
	dossierSnapshot,
	dossierStatus,
}: {
	html: string;
	title?: string;
	scripts?: boolean;
	/** 无痕模式：卡皮肤/整楼界面；agent show_html 保持 false */
	seamless?: boolean;
	minHeight?: number;
	maxHeight?: number;
	collapsible?: boolean;
	defaultOpen?: boolean;
	/** 梨园权威状态投影出的 ST/MVU 只读变量。 */
	variables?: unknown;
	/** Exact-message native MVU data for the static first-floor-compatible dossier; never executed. */
	dossierSnapshot?: unknown;
	dossierStatus?: "loading" | "unavailable";
}) {
	const frameId = useId();
	const ref = useRef<HTMLIFrameElement>(null);
	const programApp = useMemo(() => seamless && looksLikeProgramApp(html, scripts), [html, scripts, seamless]);
	const [height, setHeight] = useState(() =>
		programApp && typeof window !== "undefined" ? programViewportHeight(window) : minHeight,
	);
	const [showSource, setShowSource] = useState(false);
	const [open, setOpen] = useState(defaultOpen);
	const rawSrcDoc = buildSrcDoc(
		html,
		scripts,
		seamless,
		typeof window !== "undefined" ? window.innerHeight : undefined,
		variables,
		dossierSnapshot,
		dossierStatus,
	);
 const transport=scripts&&seamless?workspaceFrameBootstrap():"";
 const srcDoc=transport?rawSrcDoc.replace(/<head(?:\s[^>]*)?>/i,head=>head+transport):rawSrcDoc;

	/**
	 * 沙箱矩阵：
	 * - 静态 seamless：only same-origin（量高，无脚本）
	 * - 脚本帧（三档程序卡）：scripts + same-origin + forms
	 *   必须同源，否则 IndexedDB/Dexie/localStorage 在不透明源上 SecurityError，
	 *   卡初始化挂掉 → 按钮永远绑不上（某卡等）。
	 *   风险：同源脚本可读父页 DOM——仅对卡作者 HTML 开启；垫片不提供改正文通道。
	 * - agent show_html 非 seamless 脚本：仅 scripts（调试用，保持隔离）
	 */
	const sandbox = scripts
		? seamless
			? "allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
			: "allow-scripts"
		: seamless
			? "allow-same-origin"
			: "";
	const cap = seamless ? Number.POSITIVE_INFINITY : maxHeight;

	// 程序卡：跟视口，避免 120px 裁切；resize 时同步
	useEffect(() => {
		if (!programApp) return;
		const apply = () => setHeight(programViewportHeight(window));
		apply();
		window.addEventListener("resize", apply);
		return () => window.removeEventListener("resize", apply);
	}, [programApp, srcDoc]);

	// Static seamless frames have native interactive controls too (details/summary, late-loading images).
	// Observe from the same-origin host: scripts stay disabled and the iframe/node/control state is preserved.
	useEffect(() => {
		if (scripts) {
			if (!seamless) setHeight(maxHeight);
			return;
		}
		const el = ref.current;
		if (!el) return;
		let active = true;
		let pending = 0;
		let observedDocument: Document | null = null;
		let resizeObserver: ResizeObserver | undefined;
		let mutationObserver: MutationObserver | undefined;
		const fit = () => {
			pending = 0;
			if (!active) return;
			try {
				const doc = el.contentDocument;
				const body = doc?.body;
				// Measure content boxes, never feed documentElement.scrollHeight back into a 100vh frame.
				let h = 0;
				if (body) {
					for (const node of Array.from(body.children)) {
						if (["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName)) continue;
						const child = node as HTMLElement;
						h = Math.max(h, child.offsetTop + child.offsetHeight, Math.ceil(child.getBoundingClientRect().bottom));
					}
					if (h < 1) h = body.offsetHeight || 0;
				}
				if (h < 1) h = minHeight;
				const next = Math.min(cap, Math.max(minHeight, Math.ceil(h)));
				setHeight(prev => Math.abs(prev - next) < 2 ? prev : next);
			} catch {
				/* Non-seamless static frames retain their opaque origin. */
			}
		};
		const scheduleFit = () => {
			if (active && !pending) pending = window.requestAnimationFrame(fit);
		};
		const disconnect = () => {
			resizeObserver?.disconnect(); mutationObserver?.disconnect();
			observedDocument?.removeEventListener("toggle", scheduleFit, true);
			observedDocument?.removeEventListener("load", scheduleFit, true);
			observedDocument?.fonts?.removeEventListener("loadingdone", scheduleFit);
			observedDocument = null;
		};
		const bind = () => {
			if (!active) return;
			try {
				const doc = el.contentDocument;
				if (doc?.body && doc !== observedDocument) {
					disconnect(); observedDocument = doc;
					if (typeof ResizeObserver !== "undefined") {
						resizeObserver = new ResizeObserver(scheduleFit);
						resizeObserver.observe(doc.body);
						for (const node of Array.from(doc.body.children)) {
							if (!["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName)) resizeObserver.observe(node);
						}
					}
					if (typeof MutationObserver !== "undefined") {
						mutationObserver = new MutationObserver(scheduleFit);
						mutationObserver.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden", "class", "style"] });
					}
					// Native toggle/load events do not bubble; capture them on the iframe document.
					doc.addEventListener("toggle", scheduleFit, true);
					doc.addEventListener("load", scheduleFit, true);
					doc.fonts?.addEventListener("loadingdone", scheduleFit);
					void doc.fonts?.ready.then(() => { if (observedDocument === doc) scheduleFit(); });
				}
			} catch { /* Opaque sandbox: no new capabilities are granted. */ }
			scheduleFit();
		};
		el.addEventListener("load", bind);
		window.addEventListener("resize", scheduleFit);
		const first = window.setTimeout(bind, 50);
		const second = window.setTimeout(bind, 200);
		return () => {
			active = false; disconnect();
			el.removeEventListener("load", bind);
			window.removeEventListener("resize", scheduleFit);
			window.clearTimeout(first); window.clearTimeout(second);
			if (pending) window.cancelAnimationFrame(pending);
		};
	}, [srcDoc, scripts, seamless, minHeight, cap, maxHeight]);

	// 脚本帧高度上报(seamless 内容流)：小部件/状态栏跟内容。
	// 程序卡（接管型）不订阅：视口锁高，srcdoc 也不带上报器；防御性拒收避免任何乒乓回路
	useEffect(() => {
		if (!scripts || !seamless || programApp) return;
		const onMsg = (e: MessageEvent) => {
			const d = e.data as { liyuanFrameHeight?: unknown; frameId?: unknown };
			if (!d || d.frameId !== frameId || typeof d.liyuanFrameHeight !== "number" || !(d.liyuanFrameHeight > 0)) {
				return;
			}
			const raw = Math.ceil(d.liyuanFrameHeight);
			// 内容流帧（seamless 非接管型）高度上限：大方放行，蠕变靠下方 ratchet 防护。
			// 旧值 min(2400, 92%vh) 在 1080p 只有 ~828px，某卡等长欢迎消息被裁半截。
			const hardCap = typeof window !== "undefined"
				? Math.max(2400, Math.floor(window.innerHeight * 4))
				: 10000;
			const next = Math.max(minHeight, Math.min(hardCap, raw));
			setHeight((prev) => {
				if (Math.abs(prev - next) < 2) return prev;
				// 允许首次拉高；拒绝「每次只多几 px」的 100vh 蠕变
				if (next > prev && next - prev <= 8 && prev > minHeight + 20) return prev;
				return next;
			});
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [scripts, seamless, frameId, minHeight, programApp]);

	return (
		<figure
			className={`msg-html ${scripts ? "msg-html-scripts" : ""} ${seamless ? "msg-html-seamless" : ""} ${programApp ? "msg-html-program" : ""}`}
		>
			{collapsible && <button type="button" className="drawer-btn msg-html-collapse" onClick={() => setOpen((value) => !value)}>{open ? "收起界面" : `展开${title || "界面"}`}</button>}
			{open && <>
			{!seamless && (
				<div className="msg-html-bar">
					<span className="msg-html-title">{title?.trim() || (scripts ? "交互界面" : "HTML")}</span>
					<span className="msg-html-tags">
						{scripts ? <span className="chip chip-html-js">脚本</span> : <span className="chip chip-html-static">静态</span>}
						<button type="button" className="act" onClick={() => setShowSource((v) => !v)}>
							{showSource ? "收起源码" : "源码"}
						</button>
					</span>
				</div>
			)}
			{seamless && (
				<div className="msg-html-ghost">
					<button type="button" className="act" onClick={() => setShowSource((v) => !v)}>
						{showSource ? "收起源码" : "源码"}
					</button>
				</div>
			)}
			<iframe
				ref={ref}
				name={frameId}
				className="msg-html-frame"
				title={title || (seamless ? "界面" : "HTML")}
				sandbox={sandbox}
				srcDoc={srcDoc}
				style={{ height }}
			/>
			{showSource && <pre className="msg-html-source">{html}</pre>}
			{!seamless && title?.trim() && !showSource && <figcaption className="msg-html-cap">{title}</figcaption>}
			</>}
		</figure>
	);
}
