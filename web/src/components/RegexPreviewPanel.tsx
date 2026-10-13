import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RegexInspectorSnapshot, RegexRuleScope } from "../../../src/regex-inspector.ts";
import type { RegexPreviewResult } from "../../../src/regex-preview.ts";
import { splitRichContentParts } from "../richContentParts.ts";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { Paragraphs } from "./Messages.tsx";

type Scope = RegexRuleScope | "all";
export interface RegexPreviewSelection { ruleId: string; requestId: number }
interface Props {
	snapshot: RegexInspectorSnapshot;
	contextTick: number;
	scope: Scope;
	sourceId: string;
	sample?: string;
	selection?: RegexPreviewSelection | null;
}
const SCOPE_LABELS: Record<Scope, string> = { global: "全局", preset: "当前预设", local: "角色卡局部", lorebook: "挂载世界书", all: "全部来源" };
const CURRENT_SCOPE = "@current-scope";
const PREVIEW_TIMEOUT_MS = 1_000;

function staticPreviewCss(css: string): string {
	// Keep local layout CSS, but never start stylesheet/font/image requests from a preview copy.
	return css.replace(/@import\b[^;]*(?:;|$)/gi, "")
		.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (match, quoted: string | undefined, single: string | undefined, bare: string | undefined) =>
			/^(?:data:|blob:)/i.test((quoted ?? single ?? bare ?? "").trim()) ? match : 'url("")');
}

/** Only the preview copy is sanitized. The original regex output remains available as inert text. */
function staticPreviewHtml(html: string, theme: "light" | "dark"): string {
	// A detached template is inert: author resources are not fetched while the safe document is built.
	const template = document.createElement("template");
	template.innerHTML = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_match, open: string, css: string, close: string) => open + staticPreviewCss(css) + close);
	const sanitize = (fragment: DocumentFragment) => {
		fragment.querySelectorAll("script,iframe,frame,object,embed,base,link,meta,noscript").forEach((element) => element.remove());
		fragment.querySelectorAll("*").forEach((element) => {
			for (const attribute of Array.from(element.attributes)) {
				const name = attribute.name.toLowerCase();
				const value = attribute.value.trim();
				if (name.startsWith("on") || ["srcdoc", "srcset", "imagesrcset", "action", "formaction", "ping", "target", "poster", "background", "data", "codebase", "manifest"].includes(name)) {
					element.removeAttribute(attribute.name);
				} else if (name === "style") {
					element.setAttribute(attribute.name, staticPreviewCss(attribute.value));
				} else if (name === "src") {
					if (element.tagName !== "IMG" || !/^(?:data:image\/|blob:)/i.test(value)) element.removeAttribute(attribute.name);
				} else if (name === "href" || name === "xlink:href") {
					if (!value.startsWith("#")) element.removeAttribute(attribute.name);
				}
			}
			if (element instanceof HTMLTemplateElement) sanitize(element.content);
		});
	};
	sanitize(template.content);
	const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
	const dark = theme === "dark";
	const base = `:root{color-scheme:${theme};--bg:${dark ? "#141110" : "#f7f4f0"};--surface:${dark ? "#1e1a18" : "#fffcfa"};--surface-dim:${dark ? "#272220" : "#f3efe9"};--text:${dark ? "#eee8e1" : "#3d3833"};--text-strong:${dark ? "#faf6f1" : "#1c1917"};--text-soft:${dark ? "#c4bbb1" : "#6a635c"};--hairline:${dark ? "#3a342f" : "#ebe6df"};--accent:${dark ? "#e25a3c" : "#bc4123"};--accent-wash:${dark ? "#3a221c" : "#faeee7"}}body{margin:0;padding:12px;background:var(--bg);color:var(--text);font:13px/1.7 sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}img{max-width:100%}`;
	return `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style></head><body>${template.innerHTML}</body></html>`;
}

function StaticPreviewFrame({ html, theme }: { html: string; theme: "light" | "dark" }) {
	const safeHtml = useMemo(() => staticPreviewHtml(html, theme), [html, theme]);
	return <HtmlFrame html={safeHtml} scripts={false} title="正则静态预览" minHeight={180} maxHeight={500} />;
}

/** Explicit local preview only: no API/model calls, automatic execution, or story/material writes. */
export function RegexPreviewPanel({ snapshot, contextTick, scope, sourceId, sample, selection }: Props) {
	const [text, setText] = useState("");
	const [depth, setDepth] = useState(0);
	const [applySkin, setApplySkin] = useState(snapshot.skinEnabled);
	const [ruleId, setRuleId] = useState("");
	const [preview, setPreview] = useState<RegexPreviewResult | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark">(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
	const workerRef = useRef<Worker | null>(null);
	const timerRef = useRef<number | undefined>(undefined);
	const sampleRef = useRef<HTMLTextAreaElement>(null);
	const eligibleRules = useMemo(() => snapshot.rules.filter((rule) => !rule.disabled && rule.displayActive && !!rule.displayRule), [snapshot]);
	const metadata = useMemo(() => ({ snapshot, contextTick, scope, sourceId, sample }), [snapshot, contextTick, scope, sourceId, sample]);
	const metadataRef = useRef(metadata);
	metadataRef.current = metadata;

	const stopWorker = useCallback(() => {
		window.clearTimeout(timerRef.current);
		timerRef.current = undefined;
		const worker = workerRef.current;
		workerRef.current = null;
		worker?.terminate();
	}, []);
	const invalidate = useCallback((message = "") => {
		stopWorker(); setBusy(false); setPreview(null); setError(""); setNotice(message);
	}, [stopWorker]);

	useEffect(() => () => stopWorker(), [stopWorker]);
	useEffect(() => {
		invalidate(); setText(""); setDepth(0); setRuleId(""); setApplySkin(snapshot.skinEnabled);
	}, [snapshot, contextTick, invalidate]);
	useEffect(() => {
		invalidate(workerRef.current ? "来源或范围已变化，正在运行的本地预览已取消。" : "");
	}, [scope, sourceId, sample, invalidate]);
	useEffect(() => {
		if (!selection) return;
		const selected = eligibleRules.find((rule) => rule.id === selection.ruleId);
		invalidate();
		if (!selected) { setRuleId(""); return; }
		setRuleId(selected.id); setApplySkin(true);
		sampleRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
		sampleRef.current?.focus({ preventScroll: true });
	}, [selection, eligibleRules, invalidate]);
	useEffect(() => {
		const readTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
		const observer = new MutationObserver(readTheme);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		readTheme();
		return () => observer.disconnect();
	}, []);

	const runPreview = () => {
		if (!text.trim() || busy) return;
		invalidate();
		let candidates = eligibleRules;
		if (ruleId === CURRENT_SCOPE) candidates = candidates.filter((rule) => (scope === "all" || rule.scope === scope) && (!sourceId || rule.sourceId === sourceId));
		else if (ruleId) {
			const selected = candidates.find((rule) => rule.id === ruleId);
			if (!selected) { setError("这条规则已关闭或不可用于显示预览；未执行。"); return; }
			candidates = [selected];
		}
		// Do not pass a stale displayRule on an inactive/disabled row to the existing preview engine.
		const activeIds = new Set(candidates.map((rule) => rule.id));
		const safeSnapshot: RegexInspectorSnapshot = { ...snapshot, rules: snapshot.rules.map((rule) => activeIds.has(rule.id) ? rule : { ...rule, displayRule: undefined }) };
		const startedMetadata = metadata;
		let worker: Worker;
		try { worker = new Worker(new URL("../regex-preview-worker.ts", import.meta.url), { type: "module" }); }
		catch (cause) { setError(cause instanceof Error ? cause.message : "本地预览 Worker 无法启动"); return; }
		workerRef.current = worker; setBusy(true);
		timerRef.current = window.setTimeout(() => {
			if (workerRef.current !== worker || metadataRef.current !== startedMetadata) return;
			stopWorker(); setBusy(false); setPreview(null);
			setError("规则预览超过 1 秒，已终止本地 Worker；原始规则与正文未改变。");
		}, PREVIEW_TIMEOUT_MS);
		worker.onmessage = (event: MessageEvent<{ ok?: boolean; result?: RegexPreviewResult; error?: string }>) => {
			if (workerRef.current !== worker || metadataRef.current !== startedMetadata) return;
			stopWorker(); setBusy(false);
			if (event.data.ok && event.data.result && typeof event.data.result.display === "string" && Array.isArray(event.data.result.steps)) setPreview(event.data.result);
			else setError(event.data.error || "本地规则预览失败；正文未改变。");
		};
		worker.onerror = () => {
			if (workerRef.current !== worker || metadataRef.current !== startedMetadata) return;
			stopWorker(); setBusy(false); setError("本地预览进程失败；正文与原始规则未改变。");
		};
		try { worker.postMessage({ snapshot: safeSnapshot, text, depth, applySkin, ruleId: ruleId && ruleId !== CURRENT_SCOPE ? ruleId : undefined }); }
		catch (cause) { stopWorker(); setBusy(false); setError(cause instanceof Error ? cause.message : "本地预览载荷无法读取"); }
	};
	const parts = useMemo(() => preview ? splitRichContentParts(preview.display, null) : [], [preview]);

	return <section className="regex-preview" id="regex-preview" aria-labelledby="regex-preview-title" aria-busy={busy}>
		<h3 id="regex-preview-title">渲染预览</h3>
		<p className="regex-note">作者原文／测试文本 → 原显示正则 → HTML/CSS 或文字。仅显式加载与运行；不执行卡脚本、不加载外部资源、不生成图片、不调用模型，也不写回故事或素材。内置全局行动卡的固定示例仍与这里的原正则预览分开。</p>
		<div className="regex-preview-controls">
			<label><input type="checkbox" checked={applySkin} onChange={(event) => { invalidate(); setApplySkin(event.target.checked); }} />预览应用显示正则（仅本页）</label>
			<label>消息深度<input aria-label="消息深度" className="field-input" type="number" min={0} max={10000} value={depth} onChange={(event) => { invalidate(); setDepth(Math.max(0, Math.min(10000, Number(event.target.value) || 0))); }} /></label>
			<label>规则范围<select aria-label="规则范围" className="field-input" value={ruleId} onChange={(event) => { invalidate(); setRuleId(event.target.value); }}>
				<option value="">全部原显示规则（按绑定顺序）</option>
				<option value={CURRENT_SCOPE}>当前作用范围：{SCOPE_LABELS[scope]}{sourceId ? " / 当前来源" : ""}</option>
				{eligibleRules.map((rule) => <option key={rule.id} value={rule.id}>{SCOPE_LABELS[rule.scope]} · {rule.name}</option>)}
				{snapshot.rules.filter((rule) => rule.disabled).map((rule) => <option key={rule.id} value={rule.id} disabled>已关闭（不可预览） · {rule.name}</option>)}
			</select></label>
		</div>
		<p className="regex-note">勾选仅改变本地预览，不保存显示主开关，也不会启用 disabled 规则；消息深度仍按原规则生效。</p>
		<label className="field-label" htmlFor="regex-sample">作者原文 / 测试文本</label>
		<textarea ref={sampleRef} id="regex-sample" className="field-input regex-code" rows={7} value={text} onChange={(event) => { invalidate(); setText(event.target.value); }} placeholder="可显式载入当前显示轮原稿，或粘贴测试文本；不会自动运行" />
		<div className="regex-actions">
			<button type="button" className="act" disabled={!sample} onClick={() => { invalidate(); setText(sample ?? ""); }}>载入当前显示轮原稿</button>
			<button type="button" className="act" disabled={busy || !text.trim()} onClick={runPreview}>{busy ? "预览中…" : "运行本地预览"}</button>
			{busy && <button type="button" className="act" onClick={() => invalidate("已取消本地预览；原始规则与正文未改变。")}>取消预览</button>}
			<span>只在浏览器运行，不上传或保存测试文本</span>
		</div>
		{busy && <p className="regex-preview-status" role="status">本地 Worker 预览中，最多等待 1 秒；修改文本、深度、范围或切换绑定都会取消旧任务。</p>}
		{notice && <p className="regex-preview-status" role="status">{notice}</p>}
		{error && <p className="regex-preview-error" role="alert">{error}</p>}
		{preview && <>
			<p className="regex-note regex-preview-count">实际应用 {preview.steps.length} 条显示规则 · {text.length.toLocaleString()} 字输入 → {preview.display.length.toLocaleString()} 字展示。未改变文本不等于没有匹配。</p>
			<div className="regex-preview-result" role="region" aria-label="正则渲染预览">
				{parts.map((part, index) => part.kind === "html" ? <StaticPreviewFrame key={index} html={part.html} theme={theme} />
					: part.kind === "text" ? <Paragraphs key={index} text={part.text} />
						: <p key={index}>插图槽位：{part.title || "图片提示词"}（预览不生成图片）</p>)}
			</div>
			<details className="regex-preview-source"><summary>查看替换后的完整文本与应用记录</summary>
				<textarea aria-label="替换后的完整文本" className="field-input regex-code" readOnly value={preview.display} rows={8} />
				<ul>{preview.steps.map((step) => <li key={step.id}>{snapshot.rules.find((rule) => rule.id === step.id)?.name ?? step.id}：{step.changed ? "有改变" : "未改变"}（{step.beforeChars} → {step.afterChars} 字）</li>)}</ul>
			</details>
		</>}
	</section>;
}
