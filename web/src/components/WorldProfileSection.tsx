import { useEffect, useState } from "react";
import { api, apiGet, apiPost, apiPut } from "../api.ts";
import { PanelStatus, Toggle, useAction, usePanelData } from "./kit.tsx";

type ProfileModule = {
	id: string;
	name: string;
	mode: "observe" | "active" | "suspended";
	cadence: string;
	confidence: number;
	reason: string;
	stateFocus: string[];
	writerProjection: string;
	kind: string;
	skillPack: string;
};

type CardWorldProfile = {
	status: "draft" | "stable";
	revision: number;
	analyzedTurns: number;
	digest: string;
	labels: string[];
	primaryScale: string;
	defaultTimeStep: string;
	worldActivity: "quiet" | "low" | "normal" | "active" | "epic";
	modules: ProfileModule[];
	disabledModules: string[];
	userRequirements: string[];
	optimizationNotes: string[];
	unresolvedQuestions: string[];
};

type WorldProfileResponse = {
	profile: CardWorldProfile | null;
	card: { key: string; name: string };
	materialsChanged: boolean;
	analyzing?: boolean;
	configuredModel?: { provider: string; id: string } | null;
};

export function WorldProfileSection({ enabled, toast }: { enabled: boolean; toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const { data, error, loading, reload } = usePanelData(() => apiGet<WorldProfileResponse>("/api/world-profile"), { cacheKey: "/api/world-profile", watchAgent: true });
	const { busy, run } = useAction(toast);
	const [actionError, setActionError] = useState("");
	const [analyzing, setAnalyzing] = useState(false);
	const [actionStatus, setActionStatus] = useState("");
	useEffect(() => { setActionError(""); setActionStatus(""); }, [data?.card.key]);
	const [requirements, setRequirements] = useState("");
	const [notes, setNotes] = useState("");
	useEffect(() => {
		if (!data?.analyzing || analyzing) return;
		const timer = window.setTimeout(reload, 1500);
		return () => window.clearTimeout(timer);
	}, [data, analyzing, reload]);
	useEffect(() => {
		setRequirements(data?.profile?.userRequirements.join("\n") ?? "");
		setNotes(data?.profile?.optimizationNotes.join("\n") ?? "");
	}, [data?.card.key, data?.profile?.revision]);
	const save = (patch: Record<string, unknown>, done: string) => run(async () => {
		await apiPut("/api/world-profile", patch);
		reload();
	}, done);
	const analyze = () => run(async () => {
		setActionError("");
		setActionStatus("");
		setAnalyzing(true);
		try {
			const result = await apiPost<{ profile: CardWorldProfile; manifestApplied: boolean; note?: string }>("/api/world-profile/analyze", {});
			setActionStatus(result.manifestApplied ? `画像 v${result.profile.revision} 已生成并用于当前分支，已有剧情和世界状态保留。` : result.note ?? "画像已保存，当前分支未改变。");
			reload();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setActionError(message);
			throw cause;
		} finally { setAnalyzing(false); }
	}, "已按当前素材与优化记录生成角色卡世界画像");
	const clearModule = (moduleId: string) => run(async () => {
		await api(`/api/world-state/module?moduleId=${encodeURIComponent(moduleId)}`, { method: "DELETE" });
	}, `已清空模块 ${moduleId} 的当前分支运行态`);
	return <section className="sp-section">
		<h4>角色卡世界适配</h4>
		{data?.configuredModel && <div className="field-hint">画像岗位：{data.configuredModel.provider} / {data.configuredModel.id}。模型失效时请在下方“模型插头 → 角色卡世界画像”选择可用模型并保存。</div>}
		<PanelStatus loading={loading} error={error} hasData={!!data} />
		{actionError && <div className="panel-error" role="alert">{actionError}</div>}
		{actionStatus && <div className="field-hint" role="status">{actionStatus}</div>}
		{(analyzing || data?.analyzing) && <div className="field-hint" role="status">正在分析角色卡与启用资料，请稍候；完成后会保存画像，不会重新生成剧情。</div>}
		{data && !data.profile && <>
			<div className="field-hint">「{data.card.name}」尚无可用世界画像。{enabled ? "首次正文完成后会在后台建立适配，也可以现在分析。" : "世界推演当前未启用；可以手动分析，但不会自动开启推演。"}</div>
			<button className="drawer-btn primary" disabled={busy || data.analyzing} onClick={() => void analyze()}>{analyzing ? "正在分析…" : "分析这张卡"}</button>
		</>}
		{data?.profile && <>
			<div className="field-hint">{data.profile.digest}</div>
			<div className="lore-meta">画像 v{data.profile.revision} · 已复盘至第 {data.profile.analyzedTurns} 拍 · {data.profile.primaryScale} 尺度 · 默认 {data.profile.defaultTimeStep} 步进 · {data.profile.labels.join(" / ") || "未标注题材"}</div>
			{data.materialsChanged && data.profile.status !== "stable" && <div className="panel-error">角色卡、世界书、预设或开场已变化，建议重新分析适配。</div>}
			<div className="toggle-row"><span>稳定画像，不因素材变化自动重建</span><Toggle checked={data.profile.status === "stable"} disabled={busy} onChange={(stable) => void save({ status: stable ? "stable" : "draft" }, stable ? "画像已标记稳定" : "画像已恢复持续优化")} /></div>
			<label className="field-label">后台活跃度</label>
			<select className="field-input" value={data.profile.worldActivity} disabled={busy} onChange={(event) => void save({ worldActivity: event.target.value }, "后台活跃度已更新")}>
				<option value="quiet">静稳</option><option value="low">低</option><option value="normal">自然</option><option value="active">活跃</option><option value="epic">史诗</option>
			</select>
			<label className="field-label">本卡长期要求</label>
			<textarea className="field-input" rows={4} value={requirements} disabled={busy} placeholder="每行一条，例如：本卡永远不引入第三者打断二人戏" onChange={(event) => setRequirements(event.target.value)} />
			<label className="field-label">实弹优化记录</label>
			<textarea className="field-input" rows={4} value={notes} disabled={busy} placeholder="记录这张卡跑起来后需要怎样调节；后续重分析会继续参考" onChange={(event) => setNotes(event.target.value)} />
			<button className="drawer-btn" disabled={busy} onClick={() => void save({ userRequirements: requirements.split("\n").map((line) => line.trim()).filter(Boolean), optimizationNotes: notes.split("\n").map((line) => line.trim()).filter(Boolean) }, "本卡长期要求与优化记录已保存")}>保存适配笔记</button>
			<div style={{ marginTop: 10 }}>
				{data.profile.modules.map((module) => <div className="skill-lib-row" key={module.id}>
					<div className="skill-lib-main"><span className="lore-title">{module.name}<span className="skill-badge resident">{module.mode}</span></span><span className="lore-meta">{module.id} · {module.kind} / {module.skillPack} · {module.cadence} · 置信度 {Math.round(module.confidence * 100)}%</span><span className="field-hint">{module.reason}</span></div>
					<div><select className="field-input" style={{ width: 110 }} value={module.mode} disabled={busy} onChange={(event) => void save({ modules: data.profile!.modules.map((item) => item.id === module.id ? { ...item, mode: event.target.value } : item) }, `${module.name} 已切换为 ${event.target.value}`)}><option value="active">运行</option><option value="observe">观察</option><option value="suspended">暂停</option></select><button className="act" disabled={busy} onClick={() => void clearModule(module.id)}>清空本分支状态</button></div>
				</div>)}
			</div>
			{data.profile.unresolvedQuestions.length > 0 && <details><summary>待确认问题（{data.profile.unresolvedQuestions.length}）</summary><ul>{data.profile.unresolvedQuestions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
			<button className="drawer-btn primary" disabled={busy || data.analyzing} onClick={() => void analyze()}>{analyzing ? "正在分析…" : "重新分析适配"}</button>
		</>}
	</section>;
}
