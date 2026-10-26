import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { workspaceStale } from "../workspace.ts";
import { Toggle } from "./kit.tsx";
import type { NovelAiSettings, NovelAiStatus } from "../../../src/novelai-types.ts";

type Props = { toast: (level: "info" | "warning" | "error", text: string) => void };
export function NovelAiSection({ toast }: Props) {
	const [status, setStatus] = useState<NovelAiStatus | null>(null), [form, setForm] = useState<NovelAiSettings | null>(null);
	const [apiKey, setApiKey] = useState(""), [clearApiKey, setClearApiKey] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
	const request = useRef<AbortController | null>(null);
	const read = async () => {
		request.current?.abort(); const controller = new AbortController(); request.current = controller;
		setBusy(true); setError("");
		try {
			const result = await api<NovelAiStatus>("/api/novelai", { signal: controller.signal });
			if (!controller.signal.aborted) { setStatus(result); setForm(result.config); setApiKey(""); setClearApiKey(false); }
		} catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "无法读取生图设置"); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	};
	useEffect(() => {
		void read();
		const stop = () => request.current?.abort(); window.addEventListener("liyuan:workspace-changed", stop);
		return () => { stop(); window.removeEventListener("liyuan:workspace-changed", stop); };
	}, []);
	const set = (patch: Partial<NovelAiSettings>) => setForm(current => current ? { ...current, ...patch } : current);
	const save = async () => {
		if (!form || !status || busy || workspaceStale()) return;
		const controller = new AbortController(); request.current = controller; setBusy(true); setError("");
		try {
			const result = await api<NovelAiStatus>("/api/novelai", { method: "PUT", signal: controller.signal,
				body: JSON.stringify({ ...form, revision: status.revision, binding: status.binding, ...(apiKey ? { apiKey } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) }),
			});
			if (!controller.signal.aborted) { setStatus(result); setForm(result.config); setApiKey(""); setClearApiKey(false); toast("info", "NovelAI 生图设置已保存"); }
		} catch (err) { if (!controller.signal.aborted) setError(`${err instanceof Error ? err.message : "保存失败"}；未确认保存成功。必要时先刷新核对真实设置。`); }
		finally { if (!controller.signal.aborted) setBusy(false); }
	};
	return <section className="sp-section nai-settings" aria-label="NovelAI 生图">
		<h4>NovelAI 生图</h4>
		<p className="field-hint">手动生成正文中的插图，独立于故事生成。只有明确启用、保存后点击图片按钮才调用 API；可能消耗点数，刷新和翻阅历史不会自动补图。</p>
		{error && <div className="panel-error" role="alert">{error}</div>}
		{!form || !status ? <button type="button" className="drawer-btn" disabled={busy} onClick={() => void read()}>{busy ? "读取中…" : "重新读取生图设置"}</button> : <>
			{status.legacySettings && <p className="field-hint">已只读找到旧连接参数。旧文件与图片保持原样，本次恢复未自动启用；请核对后手动开启并保存。</p>}
			<fieldset disabled={busy || workspaceStale()}>
				<div className="toggle-row"><span>启用手动生图</span><Toggle checked={form.enabled} onChange={enabled => set({ enabled })} /></div>
				<label className="field-label">API Key<input className="field-input" type="password" autoComplete="new-password" value={apiKey} disabled={clearApiKey} placeholder={status.apiKeyConfigured ? "已配置，留空保持不变" : "NovelAI API Key"} onChange={e => setApiKey(e.target.value)} /></label>
				{status.apiKeyConfigured && <label className="field-label"><input type="checkbox" checked={clearApiKey} onChange={e => setClearApiKey(e.target.checked)} /> 清除已保存 Key（需先关闭生图）</label>}
				<label className="field-label">接口地址<input className="field-input" value={form.baseUrl} onChange={e => set({ baseUrl: e.target.value })} /></label>
				<label className="field-label">模型<input className="field-input" value={form.model} onChange={e => set({ model: e.target.value })} /></label>
				<div className="nai-settings-grid">
					{([["width", "宽度", 64, 2048, 64], ["height", "高度", 64, 2048, 64], ["steps", "步数", 1, 50, 1], ["scale", "CFG", 0, 20, 0.1], ["cfgRescale", "CFG Rescale", 0, 1, 0.01]] as const).map(([key, label, min, max, step]) => <label className="field-label" key={key}>{label}<input className="field-input" type="number" min={min} max={max} step={step} value={form[key]} onChange={e => set({ [key]: Number(e.target.value) })} /></label>)}
					<label className="field-label">采样器<input className="field-input" value={form.sampler} onChange={e => set({ sampler: e.target.value })} /></label>
					<label className="field-label">调度器<input className="field-input" value={form.scheduler} onChange={e => set({ scheduler: e.target.value })} /></label>
				</div>
				{([["positivePrefix", "固定正面前缀"], ["positiveSuffix", "固定正面后缀"], ["negativePrompt", "固定负面提示词"]] as const).map(([key, label]) => <label className="field-label" key={key}>{label}<textarea className="field-input" rows={3} value={form[key]} onChange={e => set({ [key]: e.target.value })} /></label>)}
				<p className="field-hint">支持完整的 &lt;image&gt; / &lt;imageTag&gt; / image### 提示词和分角色坐标。未闭合提示、未保存回复及只读记录不会提供生成操作。</p>
				<button type="button" className="drawer-btn primary" onClick={() => void save()}>保存生图设置</button>{" "}<button type="button" className="drawer-btn" onClick={() => void read()}>刷新</button>
			</fieldset>
		</>}
	</section>;
}
