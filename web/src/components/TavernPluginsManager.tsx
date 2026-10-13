import {VeridisRewriteOriginalSettings} from "./VeridisRewriteOriginalSettings.tsx";
import {VeridisRewritePanel} from "./VeridisRewritePanel.tsx";
import {NpcParallelPanel, NpcParallelOriginalSettings} from "./NpcParallelPanel.tsx";
import {MvuPanel, type MvuSettingsTarget} from "./MvuPanel.tsx";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type TavernPluginInfo, type TavernPluginsStatus } from "../api.ts";
import { IconClose } from "./icons.tsx";
import { OriginalTavernPluginManager, TavernPluginsPanel } from "./TavernPluginsPanel.tsx";

type Toast = (level: "info" | "warning" | "error", text: string) => void;

/** App-level, accessible entry point for the unchanged upstream Tavern plugin settings. */
export function TavernPluginsManager({ onClose, toast, contextTick, storyBusy = false }: { onClose: () => void; toast: Toast; contextTick: number; storyBusy?: boolean }) {
	const [selected, setSelected] = useState<{plugin:TavernPluginInfo;mvu?:MvuSettingsTarget} | null>(null);
	const [veridisSettingsOpen,setVeridisSettingsOpen]=useState(false);
	const [npcSettingsOpen, setNpcSettingsOpen] = useState(false);
	const dialogRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

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
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if(veridisSettingsOpen)setVeridisSettingsOpen(false);
			else if (npcSettingsOpen) setNpcSettingsOpen(false);
			else if (selected) setSelected(null);
			else onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, selected, npcSettingsOpen,veridisSettingsOpen]);

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

	return <div className="tavern-app-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section ref={dialogRef} className={`tavern-app-manager ${selected || npcSettingsOpen || veridisSettingsOpen ? "is-settings" : ""}`} role="dialog" aria-modal="true" aria-labelledby="tavern-app-manager-title" onKeyDown={trapFocus}>
			<header className="tavern-app-manager__header">
				<div><span className="tavern-app-manager__eyebrow">梨园 / 扩展</span><h2 id="tavern-app-manager-title">{veridisSettingsOpen?"Veridis Rewrite · 原版工作台":npcSettingsOpen ? "众生侧写 · 原版设置" : selected ? `${selected.mvu ? "MVU 变量框架" : selected.plugin.name} · 原版管理台` : "酒馆插件管理"}</h2>
					<p>{selected || npcSettingsOpen || veridisSettingsOpen ? "原版功能，中文界面。设置绑定当前会话与角色卡。" : "酒馆助手、提示词模板与 MVU，一处管理。"}</p></div>
				<button ref={closeRef} type="button" className="icon-btn" aria-label="关闭酒馆插件管理" onClick={onClose}><IconClose size={19} /></button>
			</header>
			{veridisSettingsOpen ? <VeridisRewriteOriginalSettings contextTick={contextTick} onBack={()=>setVeridisSettingsOpen(false)} /> : npcSettingsOpen ? <NpcParallelOriginalSettings embedded theme={document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"} contextTick={contextTick} onBack={() => { setNpcSettingsOpen(false); requestAnimationFrame(() => closeRef.current?.focus()); }} /> : selected ? <OriginalTavernPluginManager
				key={`${selected.plugin.id}:${selected.mvu?.commit ?? selected.plugin.commit ?? "unverified"}:${contextTick}`}
				plugin={selected.plugin}
                mvu={selected.mvu}
				contextTick={contextTick}
				presentation="inline"
				onClose={() => { setSelected(null); requestAnimationFrame(() => closeRef.current?.focus()); }}
			/> : <div className="tavern-plugins-manager-content">
				<VeridisRewritePanel contextTick={contextTick} storyBusy={storyBusy} onOpenSettings={()=>setVeridisSettingsOpen(true)} />
                <NpcParallelPanel onOpenSettings={() => setNpcSettingsOpen(true)} toast={toast} contextTick={contextTick} storyBusy={storyBusy} />
                <TavernPluginsPanel toast={toast} contextTick={contextTick} managerMode onOpenOriginal={plugin=>setSelected({plugin})} />
    <MvuPanel toast={toast} contextTick={contextTick} storyBusy={storyBusy} onOpenSettings={async(target,signal)=>{
                    const status=await api<TavernPluginsStatus>("/api/tavern-plugins/status",{signal});
                    signal.throwIfAborted();
                    const helper=status.plugins.find(plugin=>plugin.id==="helper");
                    if(!helper?.installed||!helper.enabled)throw new Error("原酒馆助手尚未安装或启用，请先检查助手状态。");
                    setSelected({plugin:helper,mvu:target});
                }}/>
			</div>}
		</section>
	</div>;
}
