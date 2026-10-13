import {VeridisRewriteOriginalSettings} from "./VeridisRewriteOriginalSettings.tsx";
import {VeridisRewritePanel} from "./VeridisRewritePanel.tsx";
import {NpcParallelPanel, NpcParallelOriginalSettings} from "./NpcParallelPanel.tsx";
import {MvuPanel, type MvuSettingsTarget} from "./MvuPanel.tsx";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type TavernPluginInfo, type TavernPluginsStatus } from "../api.ts";
import { IconClose } from "./icons.tsx";
import { OriginalTavernPluginManager, TavernPluginsPanel } from "./TavernPluginsPanel.tsx";
import { pluginCategories, pluginRegistry, type PluginId } from "../plugins/registry.ts";
import { PluginLeaveContext, PluginLeaveError, usePluginLeave } from "../plugins/usePluginLeave.tsx";

type Toast = (level: "info" | "warning" | "error", text: string) => void;

/** App-level, accessible entry point for the unchanged upstream Tavern plugin settings. */
export function TavernPluginsManager({ onClose, toast, contextTick, storyBusy = false }: { onClose: () => void; toast: Toast; contextTick: number; storyBusy?: boolean }) {
	const [selected, setSelected] = useState<{plugin:TavernPluginInfo;mvu?:MvuSettingsTarget} | null>(null);
	const [veridisSettingsOpen,setVeridisSettingsOpen]=useState(false);
	const [npcSettingsOpen, setNpcSettingsOpen] = useState(false);
	const [activePlugin, setActivePlugin] = useState<PluginId | null>(null);
	const detailTitle = useRef<HTMLHeadingElement>(null);
	const active = pluginRegistry.find(plugin => plugin.id === activePlugin);
	const dialogRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const { leave, pending: leaving, error: leaveError, discard } = usePluginLeave(dialogRef, contextTick);

	useEffect(() => {
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
		if (!selected && !npcSettingsOpen && !veridisSettingsOpen) requestAnimationFrame(() => closeRef.current?.focus());
	}, [selected, npcSettingsOpen,veridisSettingsOpen]);

	useEffect(() => {
		detailTitle.current?.focus();
	}, [activePlugin]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			leave(() => {
				if(veridisSettingsOpen)setVeridisSettingsOpen(false);
				else if (npcSettingsOpen) setNpcSettingsOpen(false);
				else if (selected) setSelected(null);
				else if (activePlugin) setActivePlugin(null);
				else onClose();
			});
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, selected, npcSettingsOpen,veridisSettingsOpen, activePlugin, leave]);

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
		<section ref={dialogRef} className={`tavern-app-manager ${selected || npcSettingsOpen || veridisSettingsOpen ? "is-settings" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tavern-app-manager-title" onKeyDown={trapFocus}>
			<header className="tavern-app-manager__header">
				<div><span className="tavern-app-manager__eyebrow">梨园 / 扩展</span><h2 id="tavern-app-manager-title">{veridisSettingsOpen?"Veridis Rewrite · 原版工作台":npcSettingsOpen ? "众生侧写 · 原版设置" : selected ? `${selected.mvu ? "MVU 变量框架" : selected.plugin.name} · 原版管理台` : "酒馆插件管理"}</h2>
					<p>{selected || npcSettingsOpen || veridisSettingsOpen ? "原版功能，中文界面。设置绑定当前会话与角色卡。" : "插件中心 / 为故事添一分可能，原稿始终保留。"}</p></div>
				<button ref={closeRef} type="button" className="icon-btn" disabled={leaving} aria-label="关闭酒馆插件管理" onClick={() => leave(onClose)}><IconClose size={19} /></button>
			</header>
			{leaving && <p className="npc-parallel-feedback" role="status">正在等待原设置保存确认，请勿关闭浏览器…</p>}
			<PluginLeaveError error={leaveError} discard={discard} />
			{veridisSettingsOpen ? <VeridisRewriteOriginalSettings contextTick={contextTick} onBack={()=>setVeridisSettingsOpen(false)} /> : npcSettingsOpen ? <NpcParallelOriginalSettings embedded theme={document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"} contextTick={contextTick} onBack={() => { setNpcSettingsOpen(false); requestAnimationFrame(() => closeRef.current?.focus()); }} /> : selected ? <OriginalTavernPluginManager
				key={`${selected.plugin.id}:${selected.mvu?.commit ?? selected.plugin.commit ?? "unverified"}:${contextTick}`}
				plugin={selected.plugin}
                mvu={selected.mvu}
				contextTick={contextTick}
				presentation="inline"
				onClose={() => { setSelected(null); requestAnimationFrame(() => closeRef.current?.focus()); }}
			/> : <div className="plugin-center">
				<nav className="plugin-center-nav" aria-label="插件分类导航">
					<button type="button" aria-current={!activePlugin ? "page" : undefined} onClick={() => setActivePlugin(null)}>全部插件 <span>{pluginRegistry.length}</span></button>
					{pluginCategories.map(category => <div className="plugin-center-nav-group" key={category.id}>
						<h3>{category.label}</h3>
						{pluginRegistry.filter(plugin => plugin.category === category.id).map(plugin => <button key={plugin.id} type="button" aria-current={activePlugin === plugin.id ? "page" : undefined} onClick={() => setActivePlugin(plugin.id)}><span className="plugin-nav-mark" aria-hidden="true">{plugin.mark}</span>{plugin.name}</button>)}
					</div>)}
					<p className="plugin-center-nav-note">固定来源接入<br />安装与启用分开管理</p>
				</nav>
				<div className="tavern-plugins-manager-content plugin-center-content" key={activePlugin ?? "overview"}>
					<header className="plugin-center-heading"><span className="tavern-app-manager__eyebrow">{active ? `${active.subtitle} / 管理` : "EXTENSIONS / 扩展目录"}</span><h3 ref={detailTitle} tabIndex={-1}>{active?.name ?? "让创作，各有所长"}</h3><p>{active?.description ?? "从卡面交互到场外众生，选择一项接入，查看状态与原版设置。"}</p></header>
					{!activePlugin ? <>
						<div className="plugin-overview-grid">{pluginRegistry.map((plugin, index) => <button type="button" className="plugin-overview-card" key={plugin.id} onClick={() => setActivePlugin(plugin.id)} aria-label={`管理${plugin.name}`}>
							<div className="plugin-overview-card-top"><span className="plugin-overview-mark" aria-hidden="true">{plugin.mark}</span><span className="plugin-overview-number" aria-hidden="true">0{index + 1}</span></div>
							<span className="plugin-overview-subtitle">{plugin.subtitle}</span><strong>{plugin.name}</strong><p>{plugin.description}</p><span className="plugin-overview-footer">{plugin.note}<span aria-hidden="true">→</span></span>
						</button>)}</div>
						<p className="plugin-center-footnote">目录不代表已安装或已启用。实际状态在详情中读取；梨园兼容宿主不等同于完整酒馆环境。</p>
					</> : <div className="plugin-center-detail">
						{activePlugin === "veridis" && <VeridisRewritePanel contextTick={contextTick} storyBusy={storyBusy} onOpenSettings={()=>setVeridisSettingsOpen(true)} />}
						{activePlugin === "npc" && <NpcParallelPanel onOpenSettings={() => setNpcSettingsOpen(true)} toast={toast} contextTick={contextTick} storyBusy={storyBusy} />}
						{(activePlugin === "helper" || activePlugin === "template") && <TavernPluginsPanel pluginId={activePlugin} toast={toast} contextTick={contextTick} storyBusy={storyBusy} managerMode onOpenOriginal={plugin=>setSelected({plugin})} />}
    {activePlugin === "mvu" && <MvuPanel toast={toast} contextTick={contextTick} storyBusy={storyBusy} onOpenSettings={async(target,signal)=>{
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
