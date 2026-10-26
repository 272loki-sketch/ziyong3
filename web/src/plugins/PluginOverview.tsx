import { useEffect, useRef, useState } from "react";
import { api, type TavernPluginsStatus } from "../api.ts";
import type { MvuUiState } from "../mvu-ui.ts";
import type { NpcSidewriteStatus } from "../components/NpcParallelPanel.tsx";
import { pluginRegistry, type PluginId } from "./registry.ts";

type Summary = { label: string; detail: string; tone: "muted" | "ready" | "attention" | "error" };
type Summaries = Partial<Record<PluginId, Summary>>;
const enabled = (on: boolean): Summary => ({ label: on ? "已启用" : "已关闭", detail: on ? "已开启执行开关" : "设置与已有记录保留", tone: on ? "ready" : "muted" });

/** Read-only inspection is opt-in; the catalog never installs, enables or runs a plugin. */
export function PluginOverview({ contextTick, onSelect }: { contextTick: number; onSelect: (id: PluginId) => void }) {
	const [statuses, setStatuses] = useState<Summaries>({});
	const [loading, setLoading] = useState(false);
	const [checkedAt, setCheckedAt] = useState("");
	const request = useRef<AbortController | null>(null);
	useEffect(() => {
		setStatuses({}); setCheckedAt(""); setLoading(false);
		return () => request.current?.abort();
	}, [contextTick]);
	const inspect = async () => {
		if (loading) return;
		request.current?.abort();
		const controller = new AbortController(); request.current = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
		setLoading(true); setStatuses({}); setCheckedAt("");
		const read = async (ids: PluginId[], load: () => Promise<Summaries>) => {
			try {
				const result = await load();
				if (!controller.signal.aborted) setStatuses(current => ({ ...current, ...result }));
			} catch {
				if (!controller.signal.aborted) setStatuses(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, { label: "读取失败", detail: "打开详情重试，安装与启用状态尚未确认", tone: "error" }])) }));
			}
		};
		await Promise.all([
			read(["helper", "template"], async () => {
				const status = await api<TavernPluginsStatus>("/api/tavern-plugins/status", { signal });
				const result: Summaries = {};
				for (const id of ["helper", "template"] as const) {
					const plugin = status.plugins.find(item => item.id === id);
					if (!plugin || typeof plugin.enabled !== "boolean" || typeof plugin.installed !== "boolean") throw new Error("Incomplete status");
					result[id] = plugin.lastError ? { label: "需要检查", detail: "上次来源更新未完成；查看详情", tone: "attention" }
						: !plugin.installed ? { label: "未安装", detail: "打开详情安装已核验的原版", tone: "muted" }
						: { ...enabled(plugin.enabled), detail: plugin.pendingActivation ? "候选待验收／待切换" : `已安装 ${plugin.version ?? "固定版本"}${status.checking ? " · 正在检查来源" : ""}` };
				}
				return result;
			}),
			read(["mvu"], async () => {
				const s = await api<MvuUiState>("/api/tavern-plugins/mvu/view", { signal });
				if (typeof s.enabled !== "boolean" || typeof s.installed !== "boolean" || !s.helper) throw new Error("Incomplete status");
				return { mvu: !s.installed ? { label: "未安装", detail: "原版框架尚未通过安装校验", tone: "muted" }
					: s.enabled && (!s.helper.enabled || !s.helper.installed) ? { label: "依赖未就绪", detail: "请先安装并启用酒馆助手", tone: "attention" }
					: s.receipt?.status === "failed" ? { label: "本拍未完成", detail: "查看收据与变量恢复资格", tone: "attention" }
					: { ...enabled(s.enabled), detail: s.pluginBusy || s.streaming ? "本拍任务进行中 · 暂停管理操作" : "查看变量收据与原版设置" } };
			}),
			read(["npc"], async () => {
				const s = await api<NpcSidewriteStatus>("/api/npc-parallel/status", { signal });
				if (typeof s.enabled !== "boolean" || typeof s.settings?.enabled !== "boolean" || typeof s.ecologyEnabled !== "boolean") throw new Error("Incomplete status");
				return { npc: !s.enabled ? enabled(false)
					: !s.ecologyEnabled || !s.model ? { label: "依赖未就绪", detail: !s.ecologyEnabled ? "鲜活世界尚未开启" : "众生侧写模型岗位未配置", tone: "attention" }
					: !s.settings.enabled ? { label: "本会话停用", detail: "全局开关已开启，本会话不运行", tone: "muted" }
					: s.receipt?.status === "failed" ? { label: "本拍未完成", detail: "查看鲜活世界采纳回执", tone: "attention" }
					: { ...enabled(true), detail: s.busy ? "本拍任务进行中 · 暂停管理操作" : "等待下一拍后台结算" } };
			}),
			read(["veridis"], async () => {
				const s = await api<{ installed: boolean; enabled: boolean; busy: boolean; model?: unknown; lastError?: string; receipt?: { status: string } }>("/api/veridis-rewrite/status", { signal });
				if (typeof s.enabled !== "boolean" || typeof s.installed !== "boolean") throw new Error("Incomplete status");
				return { veridis: !s.installed ? { label: "未安装", detail: "打开详情安装原版工作台", tone: "muted" }
					: s.enabled && !s.model ? { label: "依赖未就绪", detail: "显示润色模型岗位未配置", tone: "attention" }
					: s.lastError || s.receipt?.status === "failed" ? { label: "需要检查", detail: "查看更新或本拍处理回执", tone: "attention" }
					: { ...enabled(s.enabled), detail: s.busy ? "本拍任务进行中 · 暂停管理操作" : "只替换显示，保留作者原稿" } };
			}),
			read(["fish"], async () => {
				const s = await api<{ config: { enabled: boolean }; keyConfigured: boolean }>("/api/fish-tts/status", { signal });
				if (typeof s.config?.enabled !== "boolean" || typeof s.keyConfigured !== "boolean") throw new Error("Incomplete status");
				return { fish: s.config.enabled && !s.keyConfigured ? { label: "连接未配置", detail: "请先保存 Fish API Key", tone: "attention" } : { ...enabled(s.config.enabled), detail: "手动播放 · 此次读取不合成音频" } };
			}),
		]);
		if (!controller.signal.aborted) { setLoading(false); setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })); }
	};
	return <>
		<div className="plugin-overview-toolbar"><div><strong>接入概览</strong><p role="status">{loading ? "正在读取各插件状态…" : checkedAt ? `状态快照 · ${checkedAt}，详情中可核对最新状态` : "按需读取安装、开关与依赖状态"}</p></div><button type="button" className="npc-parallel-button" disabled={loading} onClick={() => void inspect()}>{loading ? "正在读取…" : checkedAt ? "刷新全部状态" : "读取全部状态"}</button></div>
		<div className="plugin-overview-grid">{pluginRegistry.map((plugin, index) => {
			const status = statuses[plugin.id];
			return <button type="button" className="plugin-overview-card" data-plugin-card={plugin.id} key={plugin.id} onClick={() => onSelect(plugin.id)} aria-label={`管理${plugin.name}`} aria-describedby={`plugin-summary-${plugin.id}`}>
				<div className="plugin-overview-card-top"><span className="plugin-overview-mark" aria-hidden="true">{plugin.mark}</span><span className="plugin-overview-number" aria-hidden="true">0{index + 1}</span></div>
				<span className="plugin-overview-subtitle">{plugin.subtitle}</span><strong>{plugin.name}</strong><p>{plugin.description}</p>
				<span id={`plugin-summary-${plugin.id}`} className="plugin-overview-status"><span className={`plugin-status-badge is-${status?.tone ?? "muted"}`}>{status?.label ?? (loading ? "读取中" : "尚未读取")}</span><span>{status?.detail ?? plugin.note}</span></span>
				<span className="plugin-overview-footer">查看状态与设置<span aria-hidden="true">→</span></span>
			</button>;
		})}</div>
		<p className="plugin-center-footnote">状态读取不会安装、启用插件或发起模型、配音请求。开关与本拍处理结果分别在详情中管理。</p>
	</>;
}
