import { useContext, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { FishTtsPreview } from "../../../src/fish-tts.ts";
import { scopedUrl, workspaceStale } from "../workspace.ts";
import { claimFishPlayback } from "../plugins/fish-tts-playback.ts";
import { PanelRefreshContext } from "./kit.tsx";
import { IconSpeaker } from "./icons.tsx";
import "./FishTtsPanel.css";

export function FishTtsPlayer({ text, voiceId, entryId, entryScope, contextTick = 0 }: { text: string; voiceId?: string; entryId?: string; entryScope?: string; contextTick?: number }) {
	const [draft, setDraft] = useState(text), [preview, setPreview] = useState<FishTtsPreview | null>(null);
	const [error, setError] = useState(""), [note, setNote] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [src, setSrc] = useState("");
	const audio = useRef<HTMLAudioElement>(null), task = useRef<AbortController | null>(null), release = useRef<(() => void) | null>(null);
	const stop = () => { task.current?.abort(); task.current = null; audio.current?.pause(); setBusy(false); setLoading(false); release.current?.(); release.current = null; };
	const stopRef = useRef(stop); stopRef.current = stop;
	// Audio source is owned by this controller, not both React and an imperative play().
	// Re-applying the same src during the state commit would abort a just-started play.
	useEffect(() => { if (!src && audio.current) { audio.current.removeAttribute("src"); audio.current.load(); } }, [src]);
	const payload = (content: string) => ({ text: content, ...(voiceId ? { voiceId } : {}), ...(entryId ? { entryId } : {}), ...(entryScope ? { entryScope } : {}) });
	const inspect = async (content: string) => {
		stop(); setPreview(null); setSrc(""); setError(""); setNote(""); setLoading(true);
		const controller = new AbortController(); task.current = controller;
		try {
			if (workspaceStale()) throw new Error("工作区已变化，请刷新页面后重试");
			const result = await api<FishTtsPreview>(scopedUrl("/api/fish-tts/preview"), { method: "POST", body: JSON.stringify(payload(content)), signal: controller.signal });
			if (!controller.signal.aborted) setPreview(result);
		} catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取配音预览"); }
		finally { if (task.current === controller) { task.current = null; setLoading(false); } }
	};
	useEffect(() => {
		setDraft(text); void inspect(text);
		const changed = () => { stopRef.current(); setPreview(null); setSrc(""); setError("工作区已变化，旧配音已停止，请重新预览。"); };
		const settingsChanged = () => { stopRef.current(); setPreview(null); setSrc(""); setError("配音设置已更新，旧配音已停止；请重新预览。"); };
		window.addEventListener("liyuan:workspace-changed", changed);
		window.addEventListener("liyuan:fish-tts-settings-changed", settingsChanged);
		return () => { stopRef.current(); window.removeEventListener("liyuan:workspace-changed", changed); window.removeEventListener("liyuan:fish-tts-settings-changed", settingsChanged); };
	}, [text, voiceId, entryId, entryScope, contextTick]);
	const speak = async () => {
		if (!preview || busy) return;
		setError(""); setNote(""); stop(); setBusy(true);
		const controller = new AbortController(); task.current = controller;
		release.current = claimFishPlayback(() => stopRef.current());
		try {
			if (workspaceStale()) throw new Error("工作区已变化，请重新打开当前故事");
			const result = await api<{ src: string; cached: boolean }>(scopedUrl("/api/fish-tts/synthesize"), { method: "POST", body: JSON.stringify({ ...payload(draft), binding: preview.binding, revision: preview.revision }), signal: controller.signal });
			if (controller.signal.aborted) return;
			setSrc(scopedUrl(result.src)); setNote(result.cached ? "复用已有音频，未再次调用 Fish。" : "配音已生成；计费以 Fish Audio 记录为准。");
			if (audio.current) {
				audio.current.src = scopedUrl(result.src);
				try { await audio.current.play(); } catch { if (!controller.signal.aborted) setNote("音频已生成；浏览器限制自动播放，请点击下方播放器。"); }
			}
		} catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "配音失败"); }
		finally { if (task.current === controller) { task.current = null; setBusy(false); } }
	};
	return <section className="fish-tts-player" aria-label="角色配音预览与播放">
		<label>本次配音选段（只影响语音，不修改故事）<textarea aria-label="本次配音选段" rows={4} value={draft} onChange={event => { stop(); setDraft(event.target.value); setPreview(null); setSrc(""); setNote(""); }} /></label>
		<div className="fish-tts-actions"><button type="button" onClick={() => void inspect(draft)} disabled={loading || busy}>识别预览（不调用 Fish）</button><button type="button" className="is-primary" onClick={() => void speak()} disabled={loading || busy || !preview?.segments.length || !preview.config.enabled || !preview.keyConfigured}>{busy ? "正在生成…" : "生成并播放"}</button><button type="button" onClick={stop}>停止</button></div>
		{loading && <p role="status">正在读取角色音色与识别结果…</p>}
		{error && <p className="fish-tts-error" role="alert">{error}</p>}
		{note && <p role="status">{note}</p>}
		{preview && <>
			{(!preview.config.enabled || !preview.keyConfigured) && <p className="fish-tts-hint">请先到插件中心 → Fish Audio 角色配音，保存 API Key、绑定音色并显式启用。</p>}
			{preview.warnings.map(warning => <p className="fish-tts-hint" key={warning}>{warning}</p>)}
			<ol className="fish-tts-segments" aria-label="识别到的对白">{preview.segments.map((segment, index) => <li key={index}><strong>{segment.kind === "narration" ? `旁白 · ${segment.speaker}` : segment.speaker}</strong><span>{segment.text}</span></li>)}</ol>
		</>}
		<audio ref={audio} controls preload="none" hidden={!src} onError={() => { if (src) setError("音频无法播放或来源已过期，请重新预览后生成；已有缓存不会重复调用 Fish。"); }} onPlay={() => { release.current?.(); release.current = claimFishPlayback(() => stopRef.current()); }} />
		<small>只在点击“生成并播放”时发送选段给 Fish。停止会取消等待，不保证撤销已经发生的计费。</small>
	</section>;
}
export function FishTtsMessage({ text, entryId, entryScope }: { text: string; entryId?: string; entryScope?: string }) {
	const [open, setOpen] = useState(false), contextTick = useContext(PanelRefreshContext);
	return <div className="fish-tts-message"><button type="button" className="act" aria-expanded={open} onClick={() => setOpen(value => !value)}><IconSpeaker size={13} /> {open ? "收起角色配音" : "角色配音"}</button>{open && <FishTtsPlayer text={text} entryId={entryId} entryScope={entryScope} contextTick={contextTick} />}</div>;
}
