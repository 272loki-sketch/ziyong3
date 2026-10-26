import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { MODELS } from "../../../packages/fish-audio/upstream/validate.js";
import { fishReferenceId, validateFishTtsConfig, type FishTtsConfig, type FishTtsStatus, type FishTtsVoice } from "../../../src/fish-tts.ts";
import { fishTtsSettingsChanged } from "../plugins/fish-tts-playback.ts";
import { scopedUrl, workspaceStale } from "../workspace.ts";
import { FishTtsPlayer } from "./FishTtsPlayer.tsx";
import "./FishTtsPanel.css";

export function FishTtsPanel({ contextTick, onDirtyChange }: { contextTick: number; onDirtyChange?: (dirty: boolean) => void }) {
	const [status, setStatus] = useState<FishTtsStatus | null>(null), [config, setConfig] = useState<FishTtsConfig | null>(null), [key, setKey] = useState("");
	const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
	const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
	const [audition, setAudition] = useState<string | null>(null), [sample, setSample] = useState("你好，这是我的声音。"), [reload, setReload] = useState(0), [stale, setStale] = useState(false);
	const dirtyRef = useRef(dirty), tickRef = useRef(contextTick), request = useRef<AbortController | null>(null);
	dirtyRef.current = dirty;
	useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
	useEffect(() => {
		const changed = tickRef.current !== contextTick; tickRef.current = contextTick;
		if (changed && dirtyRef.current) { request.current?.abort(); setBusy(false); setStale(true); setError("故事来源已变化。未保存的编辑仍保留；请先复制需要的音色，再刷新设置，不会写入新来源。"); return; }
		const controller = new AbortController(); request.current?.abort(); request.current = controller;
		setError(""); setBusy(true); setAudition(null);
		void api<FishTtsStatus>(scopedUrl("/api/fish-tts/status"), { signal: controller.signal }).then(value => {
			if (!controller.signal.aborted) { setStatus(value); setConfig(value.config); setAliasDraft({}); setKey(""); setDirty(false); setStale(false); }
		}).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "配音设置加载失败"); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
		return () => controller.abort();
	}, [contextTick, reload]);
	useEffect(() => { const before = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } }; window.addEventListener("beforeunload", before); return () => { request.current?.abort(); window.removeEventListener("beforeunload", before); }; }, []);
	const edit = (patch: Partial<FishTtsConfig>) => { setConfig(value => value && { ...value, ...patch }); setDirty(true); setNote(""); setAudition(null); };
	const voiceEdit = (id: string, patch: Partial<FishTtsVoice>) => { if (config) edit({ voices: config.voices.map(voice => voice.id === id ? { ...voice, ...patch } : voice) }); };
	const save = async () => {
		if (!config || !status || stale || busy) return;
		setError(""); setNote("");
		let normalized: FishTtsConfig;
		try {
			if (workspaceStale()) throw new Error("工作区已变化，请刷新后再保存");
			normalized = validateFishTtsConfig(config);
		} catch (cause) { setError(cause instanceof Error ? cause.message : "设置格式无效"); return; }
		const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true);
		try {
			const value = await api<FishTtsStatus>(scopedUrl("/api/fish-tts/config"), { method: "PUT", body: JSON.stringify({ binding: status.binding, revision: status.revision, config: normalized, ...(key.trim() ? { apiKey: key.trim() } : {}) }), signal: controller.signal });
			if (!controller.signal.aborted && request.current === controller) {
				setStatus(value); setConfig(value.config); setAliasDraft({}); setKey(""); setDirty(false); setAudition(null); setNote("音色与配音设置已保存。未发起语音合成。"); fishTtsSettingsChanged();
			}
		} catch (cause) { if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : "设置保存失败"); }
		finally { if (!controller.signal.aborted && request.current === controller) setBusy(false); }
	};
	const checkConnection = async () => {
		if (!status || busy || dirty || stale) return;
		const controller = new AbortController(); request.current?.abort(); request.current = controller; setBusy(true); setError(""); setNote("");
		try {
			const result = await api<{ reachable: boolean; httpStatus: number; elapsedMs: number; synthesisRequested: boolean }>(scopedUrl("/api/fish-tts/connection-check"), { method: "POST", body: JSON.stringify({ binding: status.binding, revision: status.revision }), signal: controller.signal });
			if (!controller.signal.aborted && request.current === controller) setNote(`Fish 官方接口已连通（HTTP ${result.httpStatus}，${result.elapsedMs} ms）。本次未发送 Key、配音文字或合成请求，不验证 Key 和音色，不产生合成费用。`);
		} catch (cause) { if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : "连接检查失败"); }
		finally { if (!controller.signal.aborted && request.current === controller) setBusy(false); }
	};
	const clearKey = async () => {
		if (!status || dirty || busy || stale || !window.confirm("删除服务端已保存的 Fish API Key？不删除音色表；若设置了环境变量，仍会使用环境变量中的 Key。")) return;
		setBusy(true); setError(""); const controller = new AbortController(); request.current?.abort(); request.current = controller;
		try { const value = await api<FishTtsStatus>(scopedUrl("/api/fish-tts/config"), { method: "PUT", body: JSON.stringify({ binding: status.binding, revision: status.revision, config: status.config, apiKey: "" }), signal: controller.signal }); if (!controller.signal.aborted) { setStatus(value); setConfig(value.config); setAudition(null); setNote("已删除本地保存的 Key。"); fishTtsSettingsChanged(); } }
		catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "删除 Key 失败"); } finally { if (!controller.signal.aborted) setBusy(false); }
	};
	return <section className="fish-tts-panel" aria-label="Fish Audio 角色配音设置">
		<p className="fish-tts-intro">给每个角色绑定专属音色，姓名和别名命中后切换声线。同段多角色使用 Fish 的多人语音请求；不新增作者提示词、不改故事，不自动调用付费接口。</p>
		{error && <p className="fish-tts-error" role="alert">{error}</p>}{note && <p className="fish-tts-success" role="status">{note}</p>}
		<div className="fish-tts-actions"><button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm("放弃未保存的音色编辑并刷新？")) { dirtyRef.current = false; setDirty(false); setReload(value => value + 1); } }}>刷新设置</button><button type="button" className="is-primary" disabled={busy || !config || !dirty || stale} onClick={() => void save()}>{busy ? "正在处理…" : "保存配音设置"}</button><span role="status">{dirty ? "有未保存的更改" : status ? "已保存" : "尚未加载"}</span></div>
		{config && status && <>
			<fieldset disabled={busy || stale}><legend>连接与朗读</legend>
				<label className="fish-tts-check"><input type="checkbox" checked={config.enabled} onChange={event => edit({ enabled: event.target.checked })} />启用 Fish Audio 角色配音</label>
				<label>Fish 网络线路<select aria-label="Fish 网络线路" disabled={status.network?.source === "environment"} value={status.network?.source === "environment" ? status.network.mode : config.networkMode} onChange={event => edit({ networkMode: event.target.value as FishTtsConfig["networkMode"] })}><option value="system">系统直连</option><option value="compatible">兼容直连（HTTPS DNS／兼容握手）</option></select></label>
				<p className="fish-tts-hint">{status.network?.source === "environment" ? "当前线路由服务端独立配置；不修改你的音色或 Key。" : "遇到 DNS、连接重置或 TLS 握手问题时，可选择兼容直连后保存。"} 两种线路都只访问 Fish 官方 API，严格校验官方域名证书；兼容模式另向公共 HTTPS DNS 查询 Fish 自有根域，不发送文字或 Key。</p>
				<button type="button" disabled={dirty || stale} onClick={() => void checkConnection()}>检查 Fish 连接（免费，不合成）</button>
				<label>Fish API Key<input type="password" aria-label="Fish API Key" autoComplete="new-password" value={key} placeholder={status.keyConfigured ? "已配置；留空保留，输入新 Key 替换" : "粘贴 Fish Audio API Key"} onChange={event => { setKey(event.target.value); setDirty(true); setNote(""); }} /></label>
				<p className="fish-tts-hint">Key 仅存服务端私有目录，不回显。当前来源：{status.keySource === "saved" ? "服务端已保存" : status.keySource === "environment" ? "环境变量" : "未配置"}。</p>
				<button type="button" disabled={dirty || !status.keyConfigured} onClick={() => void clearKey()}>删除已保存的 Key</button>
				<div className="fish-tts-grid"><label>Fish 模型<select aria-label="Fish 模型" value={config.model} onChange={event => edit({ model: event.target.value })}>{MODELS.map(model => <option value={model} key={model}>{model}</option>)}</select></label><label>语速<input aria-label="语速" type="number" min="0.5" max="2" step="0.05" value={config.speed} onChange={event => edit({ speed: Number(event.target.value) })} /></label></div>
				<p className="fish-tts-hint">模型的可用性、资费和数据条款以 Fish Audio 为准。本插件不承诺免费，不自动重试失败的合成。</p>
				<label className="fish-tts-check"><input type="checkbox" checked={config.readNarration} onChange={event => edit({ readNarration: event.target.checked })} />同时朗读旁白／未署名文字</label>
				<label>旁白音色<select aria-label="旁白音色" value={config.narratorVoiceId} onChange={event => edit({ narratorVoiceId: event.target.value })}><option value="">不指定（默认跳过旁白）</option>{config.voices.filter(voice => voice.enabled).map(voice => <option value={voice.id} key={voice.id}>{voice.name}</option>)}</select></label>
			</fieldset>
			<fieldset disabled={busy || stale}><legend>角色 → 音色 ID</legend>
				<p className="fish-tts-hint">手动填写角色名、别名和 32 位音色 ID，也可以直接粘贴 Fish 音色页面链接。配置在当前工作区跨会话复用；不同角色的别名不能重复。</p>
				<div className="fish-tts-voices">{config.voices.map(voice => <article className="fish-tts-voice" key={voice.id}>
					<div className="fish-tts-grid"><label>角色名<input aria-label="角色名" value={voice.name} onChange={event => voiceEdit(voice.id, { name: event.target.value })} placeholder="例如：堀北铃音" /></label><label>别名（逗号分隔）<input aria-label="角色别名" value={aliasDraft[voice.id] ?? voice.aliases.join("，")} onChange={event => { setAliasDraft(old => ({ ...old, [voice.id]: event.target.value })); voiceEdit(voice.id, { aliases: event.target.value.split(/[,，]/).map(value => value.trim()).filter(Boolean) }); }} placeholder="例如：堀北，铃音" /></label></div>
					<label>Fish 音色 ID / 页面链接<input aria-label="Fish 音色 ID" value={voice.referenceId} onChange={event => voiceEdit(voice.id, { referenceId: event.target.value })} onBlur={() => { try { const id = fishReferenceId(voice.referenceId); if (id !== voice.referenceId) voiceEdit(voice.id, { referenceId: id }); } catch { /* Save reports validation without destroying a partially entered ID. */ } }} placeholder="粘贴 reference_id 或音色链接" /></label>
					<div className="fish-tts-actions"><label className="fish-tts-check"><input type="checkbox" checked={voice.enabled} onChange={event => edit({ voices: config.voices.map(row => row.id === voice.id ? { ...row, enabled: event.target.checked } : row), ...(config.narratorVoiceId === voice.id && !event.target.checked ? { narratorVoiceId: "", readNarration: false } : {}) })} />参与配音</label><button type="button" disabled={dirty || !voice.enabled} onClick={() => setAudition(voice.id)}>试听此音色</button><button type="button" onClick={() => edit({ voices: config.voices.filter(row => row.id !== voice.id), ...(config.narratorVoiceId === voice.id ? { narratorVoiceId: "", readNarration: false } : {}) })}>移除角色绑定</button></div>
				</article>)}</div>
				<button type="button" onClick={() => edit({ voices: [...config.voices, { id: crypto.randomUUID(), name: "", aliases: [], referenceId: "", enabled: true }] })}>通过 ID 添加角色音色</button>
			</fieldset>
			<label>试听文本<input aria-label="试听文本" value={sample} onChange={event => { setSample(event.target.value); setAudition(null); }} /></label>
			{audition && !dirty && <FishTtsPlayer text={sample} voiceId={audition} contextTick={contextTick} />}
			<details className="fish-tts-help"><summary>角色识别方式与边界</summary><p>支持“角色名：对白”、【角色名】对白、带姓名的“角色名说：“对白””，也匹配你填写的别名。没有明确说话人的引号不会硬猜；可在消息下的“角色配音”预览里校对或只为本次配音补上姓名。正文原样保留。</p><p>切换工作区、来源或配音设置后，旧请求拒绝迟到结果。音频仅作私有缓存，不写入故事、记忆或数据库。原有普通“配音”仍独立保留。</p><p>复用 severian-dev/st-fish-audio 与 st-fish-audio-plugin 的原版纯函数核心（MIT）；角色识别、界面及私有存储由梨园宿主适配。不加载其提示词注入、音色设计或自动播放功能。</p></details>
		</>}
	</section>;
}
