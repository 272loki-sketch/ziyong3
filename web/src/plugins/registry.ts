// Presentation metadata only. Hosts, permissions and installation remain explicitly wired.
export type PluginId = "helper" | "template" | "mvu" | "npc" | "veridis";
export type PluginCategory = "rendering" | "world" | "presentation";
export interface PluginDefinition {
	id: PluginId;
	category: PluginCategory;
	name: string;
	mark: string;
	subtitle: string;
	description: string;
	note: string;
	/** Documentation/UI contracts, not permission grants or executable host URLs. */
	integration: {
		settingsHost: "tavern" | "npc" | "veridis";
		dependsOn: readonly PluginId[];
		modelRole?: "mvuParse" | "npcParallel" | "veridisRewrite";
	};
}
export const pluginCategories = [
	{ id: "rendering", label: "渲染与模板" },
	{ id: "world", label: "变量与世界" },
	{ id: "presentation", label: "文字与呈现" },
] as const satisfies readonly { id: PluginCategory; label: string }[];

export const pluginRegistry = [
	{ id: "helper", category: "rendering", name: "酒馆助手", mark: "助", subtitle: "Tavern Helper", description: "承载角色卡 HTML、脚本与交互，让原有卡面在梨园展开。", note: "原版设置 · 脚本与渲染", integration: { settingsHost: "tavern", dependsOn: [] } },
	{ id: "template", category: "rendering", name: "提示词模板", mark: "模", subtitle: "Prompt Template", description: "管理 EJS 求值、提示词注入与消息模板，保留原插件工作方式。", note: "原版设置 · EJS 模板", integration: { settingsHost: "tavern", dependsOn: [] } },
	{ id: "mvu", category: "world", name: "MVU 变量框架", mark: "变", subtitle: "MagVarUpdate", description: "随已保存的作者交付整理派生变量，查看本拍来源与处理收据。", note: "依赖酒馆助手 · 不改正文", integration: { settingsHost: "tavern", dependsOn: ["helper"], modelRole: "mvuParse" } },
	{ id: "npc", category: "world", name: "众生侧写", mark: "众", subtitle: "NPC Parallel", description: "为镜头外的人物生成经历候选，由鲜活世界统一核对与采纳。", note: "独立模型岗位 · 生态采纳", integration: { settingsHost: "npc", dependsOn: [], modelRole: "npcParallel" } },
	{ id: "veridis", category: "presentation", name: "Veridis Rewrite", mark: "润", subtitle: "显示润色", description: "按规则润色命中的句子，以独立显示稿呈现，保留作者原稿与事实。", note: "独立模型岗位 · 显示投影", integration: { settingsHost: "veridis", dependsOn: [], modelRole: "veridisRewrite" } },
] as const satisfies readonly PluginDefinition[];
