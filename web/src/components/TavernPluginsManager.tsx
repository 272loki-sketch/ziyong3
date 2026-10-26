import { FishTtsPanel } from "./FishTtsPanel.tsx";
import {VeridisRewriteOriginalSettings} from "./VeridisRewriteOriginalSettings.tsx";
import {VeridisRewritePanel} from "./VeridisRewritePanel.tsx";
import {NpcParallelPanel} from "./NpcParallelPanel.tsx";
import {MvuPanel, type MvuSettingsTarget} from "./MvuPanel.tsx";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type TavernPluginInfo, type TavernPluginsStatus } from "../api.ts";
import { IconClose } from "./icons.tsx";
import { OriginalTavernPluginManager, TavernPluginsPanel } from "./TavernPluginsPanel.tsx";
import { pluginCategories, pluginRegistry, type PluginId } from "../plugins/registry.ts";
import { PluginOverview } from "../plugins/PluginOverview.tsx";
import { prepareTavernManager } from "../plugins/manager-prewarm.ts";
import { PluginLeaveContext, PluginLeaveError, usePluginLeave } from "../plugins/usePluginLeave.tsx";

type Toast = (level: "info" | "warning" | "error", text: string) => void;

/** App-level, accessible entry point for the unchanged upstream Tavern plugin settings. */
export function TavernPluginsManager({ onClose, toast, contextTick, storyBusy = false }: { onClose: () => void; toast: Toast; contextTick: number; storyBusy?: boolean }) {
	const [selected, setSelected] = useState<{plugin:TavernPluginInfo;mvu?:MvuSettingsTarget} | null>(null);
	const [veridisSettingsOpen,setVeridisSettingsOpen]=useState(false);
	const [activePlugin, setActivePlugin] = useState<PluginId | null>(null);
	const lastPlugin = useRef<PluginId | null>(null);
	const detailTitle = useRef<HTMLHeadingElement>(null);
	const active = pluginRegistry.find(plugin => plugin.id === activePlugin);
	const dialogRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const { leave: leaveOriginal, pending: leaving, error: leaveError, discard } = usePluginLeave(dialogRef, contextTick);
	const fishDirty = useRef(false);
	const markFishDirty = useCallback((dirty: boolean) => { fishDirty.current = dirty; }, []);
	const npcDirty = useRef(false), veridisDirty = useRef(false);
	const markNpcDirty = useCallback((dirty: boolean) => { npcDirty.current = dirty; }, []);
	const markVeridisDirty = useCallback((dirty: boolean) => { veridisDirty.current = dirty; }, []);
	const leave = (next: () => void) => {
		if (fishDirty.current && !window.confirm("Fish Audio 角色配音有未保存的编辑。放弃这些更改并离开？离开不会撤销已经保存或正在提交的设置。")) return;
		if ((npcDirty.current || veridisDirty.current) && !window.confirm("当前插件有未保存的编辑或正在提交的操作。放弃未保存的编辑并离开？离开不会撤销已经保存或正在提交的设置。")) return;
		leaveOriginal(next);
	};
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (!fishDirty.current && !npcDirty.current && !veridisDirty.current) return;
			event.preventDefault(); event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	useEffect(() => {
		prepareTavernManager();
		const previous = document.activeElement;
		const backdrop = dialogRef.current?.parentElement;
		const siblings = Array.from(backdrop?.parentElement?.children ?? [])
			.filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
			.map((element) => ({ element, inert: element.inert }));
		for (const { element } of siblings) element.inert = true;
		document.body.classList.add("tavern-plugins-manager-open");
		closeRef.current?.focus();
		const restore = () => {
			for (const { element, inert } of siblings) element.inert = inert;
			document.body.classList.remove("tavern-plugins-manager-open");
			if (previous instanceof HTMLElement && previous.isConnected && previous.offsetParent !== null) previous.focus();
			else document.querySelector<HTMLButtonElement>(".tavern-plugin-entry")?.focus();
		};
		return restore;
	}, []);

	useEffect(() => {
		if (selected || veridisSettingsOpen) return;
		const frame = requestAnimationFrame(() => {
			if (activePlugin) {
				lastPlugin.current = activePlugin;
				detailTitle.current?.focus();
				dialogRef.current?.querySelector<HTMLElement>('.plugin-center-nav [aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
			} else if (lastPlugin.current) {
				dialogRef.current?.querySelector<HTMLElement>(`[data-plugin-card="${lastPlugin.current}"]`)?.focus();
			} else closeRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [activePlugin, selected, veridisSettingsOpen]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			leave(() => {
				if(veridisSettingsOpen)setVeridisSettingsOpen(false);
				else if (selected) setSelected(null);
				else if (activePlugin) setActivePlugin(null);
				else onClose();
			});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, selected, veridisSettingsOpen, activePlugin, leave]);

	const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key !== "Tab" || !dialogRef.current) return;
		const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
		)).filter((element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
		if (!focusable.length) { event.preventDefault(); closeRef.current?.focus(); return; }
		const first = focusable[0], last = focusable.at(-1)!;
		if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
	};

	return <PluginLeaveContext.Provider value={leave}><div className="tavern-app-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) leave(onClose); }}>
		<section ref={dialogRef} className={`tavern-app-manager ${selected || veridisSettingsOpen ? "is-settings" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tavern-app-manager-title" onKeyDown={trapFocus}>
			<header className="tavern-app-manager__header">
				<div><span className="tavern-app-manager__eyebrow">梨园 / 扩展</span><h2 id="tavern-app-manager-title">{veridisSettingsOpen?"Veridis Rewrite · 原版工作台": selected ? `${selected.mvu ? "MVU 变量框架" : selected.plugin.name} · 原版管理台` : "酒馆插件管理"}</h2>
					<p>{selected || veridisSettingsOpen ? "原版功能，中文界面。设置绑定当前会话与角色卡。" : "插件中心 / 为故事添一分可能，原稿始终保留。"}</p></div>
				<button ref={closeRef} type="button" className="icon-btn" disabled={leaving} aria-label="关闭酒馆插件管理" onClick={() => leave(onClose)}><IconClose size={19} /></button>
			</header>
			{leaving && <p className="npc-parallel-feedback" role="status">正在等待原设置保存确认，请勿关闭浏览器…</p>}
			<PluginLeaveError error={leaveError} discard={discard} />
			{veridisSettingsOpen ? <VeridisRewriteOriginalSettings contextTick={contextTick} onBack={()=>setVeridisSettingsOpen(false)} /> : selected ? <OriginalTavernPluginManager
				key={`${selected.plugin.id}:${selected.mvu?.commit ?? selected.plugin.commit ?? "unverified"}:${contextTick}`}
				plugin={selected.plugin}
                mvu={selected.mvu}
				contextTick={contextTick}
				presentation="inline"
				onClose={() => { setSelected(null); requestAnimationFrame(() => closeRef.current?.focus()); }}
			/> : <div className="plugin-center">
				<nav className="plugin-center-nav" aria-label="插件分类导航">
					<button type="button" aria-current={!activePlugin ? "page" : undefined} onClick={() => leave(() => setActivePlugin(null))}>全部插件 <span>{pluginRegistry.length}</span></button>
					{pluginCategories.map(category => <div className="plugin-center-nav-group" key={category.id}>
						<h3>{category.label}</h3>
						{pluginRegistry.filter(plugin => plugin.category === category.id).map(plugin => <button key={plugin.id} type="button" aria-current={activePlugin === plugin.id ? "page" : undefined} onClick={() => { if (activePlugin !== plugin.id) leave(() => setActivePlugin(plugin.id)); }}><span className="plugin-nav-mark" aria-hidden="true">{plugin.mark}</span>{plugin.name}</button>)}
					</div>)}
					<p className="plugin-center-nav-note">固定来源接入<br />安装与启用分开管理</p>
				</nav>
				<div className="tavern-plugins-manager-content plugin-center-content" key={activePlugin ?? "overview"}>
					{/* MVU owns its heading and the navigation focus target; do not duplicate it in this wrapper. */}
					{activePlugin !== "mvu" && <header className="plugin-center-heading"><span className="tavern-app-manager__eyebrow">{active ? `${active.subtitle} / 管理` : "EXTENSIONS / 扩展目录"}</span><h3 ref={detailTitle} tabIndex={-1}>{active?.name ?? "让创作，各有所长"}</h3><p>{active?.description ?? "从卡面交互到场外众生，选择一项接入，查看状态与原版设置。"}</p></header>}
					{!activePlugin ? <PluginOverview contextTick={contextTick} onSelect={id => leave(() => setActivePlugin(id))} /> : <div className="plugin-center-detail">
						{activePlugin === "fish" && <FishTtsPanel contextTick={contextTick} onDirtyChange={markFishDirty} />}
						{activePlugin === "veridis" && <VeridisRewritePanel contextTick={contextTick} storyBusy={storyBusy} onDirtyChange={markVeridisDirty} onOpenSettings={()=>leave(()=>setVeridisSettingsOpen(true))} />}
						{activePlugin === "npc" && <NpcParallelPanel toast={toast} contextTick={contextTick} storyBusy={storyBusy} onDirtyChange={markNpcDirty} />}
						{(activePlugin === "helper" || activePlugin === "template") && <TavernPluginsPanel pluginId={activePlugin} toast={toast} contextTick={contextTick} storyBusy={storyBusy} managerMode onOpenOriginal={plugin=>setSelected({plugin})} />}
    {activePlugin === "mvu" && <MvuPanel toast={toast} contextTick={contextTick} storyBusy={storyBusy} titleRef={detailTitle} onOpenSettings={async(target,signal)=>{
                    const status=await api<TavernPluginsStatus>("/api/tavern-plugins/status",{signal});
                    signal.throwIfAborted();
                    const helper=status.plugins.find(plugin=>plugin.id==="helper");
                    if(!helper?.installed||!helper.enabled)throw new Error("原酒馆助手尚未安装或启用，请先检查助手状态。");
                    setSelected({plugin:helper,mvu:target});
                }}/>}
					</div>}
				</div>
			</div>}
		</section>
	</div></PluginLeaveContext.Provider>;
}
