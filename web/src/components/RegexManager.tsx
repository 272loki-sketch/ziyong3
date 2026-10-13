import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiGet, apiGetCacheClear } from "../api.ts";
import type { RegexInspectorSnapshot, RegexRuleScope } from "../../../src/regex-inspector.ts";
import { GLOBAL_ACTION_OPTIONS_RULE } from "../../../src/regex-options.ts";
import { ActionOptionsCard } from "../options-card.tsx";
import { IconClose } from "./icons.tsx";
import { RegexPreviewPanel, type RegexPreviewSelection } from "./RegexPreviewPanel.tsx";
import "./RegexManager.css";

type ViewScope = RegexRuleScope | "all";
const scopeNames: Record<ViewScope, string> = {
	global: "全局",
	preset: "当前预设",
	local: "角色卡局部",
	lorebook: "挂载世界书",
	all: "全部来源",
};
const kindNames = { global: "用户全局正则", preset: "预设", lorebook: "挂载世界书", card: "角色卡局部" } as const;
const OPTIONS_LAYOUT_SAMPLE = "<options>\n1. 先观察周围环境，再决定下一步\n2. 向在场人物询问刚才发生的事\n</options>";

/** Read-only scope manager with explicit, local-only author/test text preview. */
export function RegexManager({ onClose, contextTick, sample }: { onClose: () => void; contextTick: number; sample?: string }) {
	const [data, setData] = useState<RegexInspectorSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [scope, setScope] = useState<ViewScope>("global");
	const [source, setSource] = useState("");
	const [query, setQuery] = useState("");
	const [previewSelection, setPreviewSelection] = useState<RegexPreviewSelection | null>(null);
	const dialogRef = useRef<HTMLElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const previous = document.activeElement;
		const backdrop = dialogRef.current?.parentElement;
		const siblings = Array.from(backdrop?.parentElement?.children ?? [])
			.filter((node): node is HTMLElement => node instanceof HTMLElement && node !== backdrop)
			.map((node) => ({ node, inert: node.inert }));
		for (const item of siblings) item.node.inert = true;
		document.body.classList.add("regex-manager-open");
		closeRef.current?.focus();
		return () => {
			for (const item of siblings) item.node.inert = item.inert;
			document.body.classList.remove("regex-manager-open");
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			else document.querySelector<HTMLButtonElement>(".regex-entry")?.focus();
		};
	}, []);

	useEffect(() => {
		let current = true;
		setData(null);
		setLoading(true);
		setError("");
		setSource("");
		setPreviewSelection(null);
		apiGetCacheClear("/api/cardfront/regex");
		apiGet<RegexInspectorSnapshot>("/api/cardfront/regex", { bypassCache: true })
			.then((value) => { if (current) setData(value); })
			.catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
			.finally(() => { if (current) setLoading(false); });
		return () => { current = false; };
	}, [contextTick, refresh]);

	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);

	const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key !== "Tab") return;
		const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
			'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]',
		) ?? []).filter((node) => node.offsetParent !== null);
		const first = nodes[0], last = nodes.at(-1);
		if (!first) return;
		if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
			event.preventDefault(); last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault(); first.focus();
		}
	};

	const visibleSources = data?.sources.filter((item) => scope === "all" || item.scope === scope) ?? [];
	const visibleRules = data?.rules.filter((rule) => {
		const ruleSource = data.sources.find((item) => item.id === rule.sourceId);
		const ruleScope = rule.scope ?? ruleSource?.scope ?? "local";
		return (scope === "all" || ruleScope === scope)
			&& (!source || rule.sourceId === source)
			&& (!query || [rule.name, rule.find, rule.notes.join(" ")].join(" ").toLowerCase().includes(query.toLowerCase()));
	}) ?? [];
	const scopeCount = (value: ViewScope) => value === "global"
		? 1 + (data?.rules.filter((rule) => rule.scope === "global").length ?? 0)
		: value === "all" ? (data?.rules.length ?? 0) : (data?.rules.filter((rule) => rule.scope === value).length ?? 0);
	const selectScope = (next: ViewScope) => { setScope(next); setSource(""); };
	const selectPreviewRule = (ruleId: string) => setPreviewSelection((previous) => ({ ruleId, requestId: (previous?.requestId ?? 0) + 1 }));

	return <div className="regex-manager-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
		<section ref={dialogRef} className="regex-manager" role="dialog" aria-modal="true" aria-labelledby="regex-title" onKeyDown={trapFocus}>
			<header className="regex-manager__header">
				<div><span className="regex-eyebrow">梨园 / 规则范围</span><h2 id="regex-title">正则与渲染</h2><p>全局行动选项独立生效；原作者规则严格留在预设或角色卡局部。</p></div>
				<button ref={closeRef} type="button" className="icon-btn" aria-label="关闭正则与渲染" onClick={onClose}><IconClose size={19} /></button>
			</header>
			<div className="regex-manager__body">
				<nav className="regex-scope-tabs" aria-label="规则作用范围">
					{(["global", "preset", "local", "lorebook", "all"] as const).map((item) => <button key={item} type="button"
						className={scope === item ? "active" : ""} aria-pressed={scope === item} onClick={() => selectScope(item)}>
						{scopeNames[item]}<span>{loading ? "…" : scopeCount(item)}</span>
					</button>)}
				</nav>
				{loading ? <p role="status">读取当前预设与角色卡绑定规则…</p> : error ? <div className="regex-error" role="alert"><p>{error}</p><button type="button" className="act" onClick={() => setRefresh((value) => value + 1)}>重新读取规则</button></div> : data && <>
					{scope === "global" ? <section className="regex-global-rule" aria-label="全局内置行动选项规则">
						<div className="regex-global-rule__heading"><div><span className="regex-badge active">GLOBAL · 梨园内置</span><h3>{GLOBAL_ACTION_OPTIONS_RULE.name}</h3><p>稳定解析 <code>&lt;options&gt;纯文本选项&lt;/options&gt;</code>，所有角色卡使用同一行动卡样式，不读取或覆盖卡内正则。</p></div><span className="regex-global-rule__state">全卡通用</span></div>
						<div className="regex-global-rule__facts"><span>规则 ID <code>{GLOBAL_ACTION_OPTIONS_RULE.id}</code></span><span>最多 {GLOBAL_ACTION_OPTIONS_RULE.maxOptions} 项</span><span>每项最多 {GLOBAL_ACTION_OPTIONS_RULE.maxOptionChars} 字</span></div>
						<p className="regex-note">点击选项只调用消息展示方传入的主输入回调，不直接发送请求，也不改写 rpNarrative / rpAuthorDraft。若正文或已投影格式已经拥有选项卡，宿主须跳过此卡避免重复。</p>
						<div className="regex-global-example"><span className="regex-example-label">固定布局示例（合成文案）</span><ActionOptionsCard text={OPTIONS_LAYOUT_SAMPLE} /></div>
						<p className="regex-note">此内置行动卡在梨园范围内全局生效，不会把预设规则升级为全局规则。</p>
						{(data.sources.some((item) => item.scope === "global") || data.rules.some((rule) => rule.scope === "global")) && <section className="regex-global-source-rules" aria-label="用户全局正则规则">
							<h3>用户全局正则</h3><p className="regex-note">以下规则来自独立 GLOBAL 来源；与梨园内置行动选项卡分开读取，关闭状态保持原样。</p>
							{data.sources.filter((item) => item.scope === "global").map((item) => <div className="regex-global-source-meta" key={item.id}><strong>{item.name}</strong><code>{item.path}</code><span>{item.error || `${item.ruleCount} 条原规则`}</span></div>)}
							{!data.rules.some((rule) => rule.scope === "global") && <p className="regex-empty">全局规则数组为空。内置行动选项仍按独立规则处理。</p>}
							{data.rules.filter((rule) => rule.scope === "global").map((rule) => <details key={rule.id} className="regex-rule">
								<summary><strong>{rule.name}</strong><span className={rule.disabled ? "regex-badge" : "regex-badge active"}>{rule.disabled ? "已关闭" : rule.displayActive ? "显示" : rule.promptActive ? "仅送模" : "未应用"}</span></summary>
								<div className="regex-rule-body"><p>用户全局正则 · 原顺序 {rule.index + 1}</p>
									{rule.notes.map((note) => <p className="regex-note" key={note}>{note}</p>)}
									<label className="field-label">原始匹配表达式<textarea className="field-input regex-code" readOnly value={rule.find} rows={3} /></label>
									<label className="field-label">原始替换内容<textarea className="field-input regex-code" readOnly value={rule.replace} rows={5} /></label>
									<button type="button" className="act" disabled={rule.disabled || !rule.displayActive || !rule.displayRule} onClick={() => selectPreviewRule(rule.id)}>仅预览这条显示规则</button>
								</div>
							</details>)}
						</section>}
					</section> : <>
						<div className="regex-context"><div><strong>{data.charName || "未选择角色卡"}</strong><p>当前卡：{data.cardPath || "—"} · 显示正则主开关 {data.skinEnabled ? "已开启" : "已关闭"}</p></div><button type="button" className="act" onClick={() => setRefresh((value) => value + 1)}>刷新绑定</button></div>
						<p className="regex-note">执行顺序：当前预设 → 已挂载世界书 → 当前角色卡。预设只属于当前预设，角色卡规则只属于当前卡；切卡后按新绑定重新读取。禁用规则与原设置保留，不因面板打开或切卡自动启用。</p>
						<div className="regex-workspace">
							<aside className="regex-sources" aria-label="规则来源">
								<button type="button" className={!source ? "active" : ""} aria-pressed={!source} onClick={() => setSource("")}>当前范围全部 <span>{visibleRules.length}</span></button>
								{visibleSources.map((item) => <button type="button" key={item.id} className={source === item.id ? "active" : ""} aria-pressed={source === item.id} onClick={() => setSource(item.id)}>
									<small>{kindNames[item.kind]}{item.draft ? " · 当前草稿" : ""}</small><strong>{item.name}</strong><code>{item.path}</code><span>{item.error || `${item.ruleCount} 条规则`}</span>
								</button>)}
							</aside>
							<div className="regex-rules">
								<label className="field-label" htmlFor="regex-search">搜索规则</label><input id="regex-search" className="field-input" type="search" value={query} placeholder="名称、表达式或跳过原因" onChange={(event) => setQuery(event.target.value)} />
								{!visibleRules.length && <p className="regex-empty">此作用范围没有正则规则，或没有符合搜索的规则。梨园内置全局选项只在“全局”页显示。</p>}
								{visibleRules.map((rule) => {
									const ruleSource = data.sources.find((item) => item.id === rule.sourceId);
									const displayEnabled = data.skinEnabled && rule.displayActive;
									return <details key={rule.id} className="regex-rule"><summary><span className="regex-rule-number">{data.rules.indexOf(rule) + 1}</span><strong>{rule.name}</strong><span className={displayEnabled ? "regex-badge active" : "regex-badge"}>{rule.disabled ? "已关闭" : !data.skinEnabled && rule.displayActive ? "卡皮肤总开关关闭" : displayEnabled ? "显示" : rule.promptActive ? "仅送模" : "未应用"}</span></summary><div className="regex-rule-body">
										<p>{scopeNames[rule.scope]} · {ruleSource?.name ?? "未知来源"} · 原顺序 {rule.index + 1}{rule.promptActive ? " · 同时作用于送模历史" : ""}</p>
										{rule.notes.map((note) => <p className="regex-note" key={note}>{note}</p>)}
										<p className="regex-note">placement：{rule.placement.join(", ") || "无"} · markdownOnly：{String(rule.markdownOnly)} · promptOnly：{String(rule.promptOnly)} · 深度 {String(rule.minDepth ?? "不限")} ～ {String(rule.maxDepth ?? "不限")}</p>
										<label className="field-label">原始匹配表达式<textarea className="field-input regex-code" readOnly value={rule.find} rows={3} /></label>
										<label className="field-label">原始替换内容<textarea className="field-input regex-code" readOnly value={rule.replace} rows={5} /></label>
										{rule.trim.length > 0 && <p>捕获组清理：<code>{JSON.stringify(rule.trim)}</code></p>}
										<button type="button" className="act" disabled={rule.disabled || !rule.displayActive || !rule.displayRule} onClick={() => selectPreviewRule(rule.id)}>仅预览这条显示规则</button>
									</div></details>;
								})}
							</div>
						</div>
					</>}
					<RegexPreviewPanel snapshot={data} contextTick={contextTick} scope={scope} sourceId={source} sample={sample} selection={previewSelection} />
				</>}
			</div>
		</section>
	</div>;
}
