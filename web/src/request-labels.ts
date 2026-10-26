/** Only presentation labels: never rewrite request records, prompts or protocol values. */
const phases: Record<string, [string, string]> = {
 "settlement.rewrite": ["正文净化", "原作者交付后并发处理措辞，原稿与事实保持不变。"],
	prep: ["拍前准备", "整理本拍需要的资料与分支状态。"],
	database: ["数据库记忆", "运行数据库插件的记忆相关请求。"],
	"database.before": ["记忆召回 / 剧情推进 / 文学导演（数据库拍前）", "原插件发送前召回、合并文学导演与输入写回期间的实际模型请求；请求成功不等于记忆命中或导演候选有效。"],
	"database.after": ["数据库拍后整理", "原插件根据已保存正文填表、整理记忆期间的实际模型请求。"],
	"prep.recallDirector": ["记忆召回 / 剧情推进 / 文学导演", "同一次原数据库任务的完整墙钟等待与实际请求；原始阶段收据不合计，不另发独立导演请求。请求成功不等于召回命中或候选有效。"],
	"prep.database": ["记忆召回 / 剧情推进 / 文学导演", "原插件召回、合并文学导演与输入写回的完整等待耗时；新记录计入实际 SDK 派发次数，逐次请求另列，历史零调用不证明未请求。"],
	writer: ["主作者", "主作者推进创作，并交付正文与原卡格式。"],
	"agent.evidence": ["证据分析", "核对连续性、设定知情与生活生态，提供三份报告。"],
	"agent.ideas": ["创意分析", "提供两个独立创作角度，不代写正文。"],
	"agent.review": ["稿件审阅", "核对事实与原始预设，提供两份审阅报告。"],
	"settlement.recovery": ["恢复后台整理", "补办已保存正文的未完成结算，不重写故事。"],
	"prep.arrival": ["场景到达", "整理到达场景时的相关状态。"],
	"prep.continuity": ["连续性核对", "核对已有剧情的衔接。"],
	"prep.novelCalibration": ["原著校准", "核对原著相关资料。"],
	"prep.plotAdaptation": ["剧情适配", "整理本拍相关的剧情方向。"],
	"prep.director": ["文学导演", "根据已有资料提供本拍文学方向。数据库启用时并入拍前召回，不另发独立导演请求；降级表示未交付有效候选，零调用不表示合并请求未执行。"],
	"prep.sceneConductor": ["场景统筹", "整理场景内的行动与关系。"],
	"prep.memoryRecall": ["记忆召回", "检索与本拍有关的已有记忆。"],
	"prep.memoryArcs": ["人物弧线", "整理人物的长期变化线索。"],
	"settlement.planFact": ["计划事实整理", "核对计划与本拍已发生事实。"],
	"settlement.scribe": ["场记整理", "根据已保存正文更新角色账本。"],
	"settlement.supplementary": ["附属格式补交", "补齐启用资料要求但作者未交付的附属内容；保留作者原稿，通过校验的变量更新交给 MVU 结算。"],
	"settlement.worldFacts": ["世界事实整理", "提取已保存正文中的世界事实。"],
	"settlement.worldProposal": ["世界变化提案", "提出候选世界变化，提案不等于已发生事实。"],
	"settlement.worldAudit": ["世界变化核验", "核验世界变化提案与事实来源。"],
	"settlement.world": ["世界状态整理", "整理本拍之后的世界状态。"],
	"settlement.ecology": ["鲜活世界整理", "更新镜头外人物、场所与传播动态。"],
	"settlement.memory": ["记忆整理", "根据已保存正文整理记忆。数据库启用时记录原插件完整墙钟耗时；历史零框架调用不表示没有请求，阶段失败也不等于所有模型请求失败，须核对逐次回执及填表／持久化错误。"],
	"settlement.tavern": ["酒馆插件／MVU整理", "原插件事件与变量处理的完整墙钟耗时；MVU 等本拍附属补交退出后解析，其余后台领域并行。"],
	curtain: ["旧版谢幕格式", "历史兼容阶段，不代表当前正文流程另行生成格式。"],
	compaction: ["上下文压缩", "整理摘要以控制后续上下文长度。"],
	embedding: ["向量检索", "生成用于资料检索的向量。"],
	"tavern-helper": ["酒馆助手", "运行插件辅助请求，不替换主作者正文。"],
	"mvu.parse": ["MVU变量解析", "独立模型根据已交付正文解析变量变化，不改写故事正文。"],
	side: ["辅助请求", "运行正文之外的辅助任务。"],
};
// Some historical request lists use the unqualified settlement names.
for (const name of ["worldFacts", "worldProposal", "worldAudit", "ecology"]) {
	phases[name] = phases[`settlement.${name}`]!;
}

export const phaseLabel = (value: string): string => Object.hasOwn(phases, value) ? phases[value]![0] : `其他阶段（${value}）`;
export const phasePurpose = (value: string): string => Object.hasOwn(phases, value) ? phases[value]![1] : "未提供此阶段的用途说明。";

const statuses: Record<string, string> = {
	running: "运行中", success: "成功", failed: "失败", aborted: "已中断", cancelled: "已取消",
	degraded: "降级／待复核", skipped: "已跳过", reused: "已复用", pending: "待处理",
	passed: "已验证", partial: "有降级／待复核",
};
export const requestStatusLabel = (value?: string): string => !value ? "未标注" : Object.hasOwn(statuses, value) ? statuses[value]! : `未知状态（${value}）`;

const roles: Record<string, string> = { system: "系统指令", developer: "开发者指令", user: "用户消息", assistant: "模型回复", tool: "工具回执" };
export const messageRoleLabel = (value: string): string => Object.hasOwn(roles, value) ? roles[value]! : `未知角色（${value}）`;
const stops: Record<string, string> = { stop: "正常结束", length: "达到输出上限", toolUse: "调用工具", tool_calls: "调用工具", end_turn: "正常结束", aborted: "已中断", error: "请求出错", "process-restarted-without-final-receipt": "进程重启，缺少结束回执" };
export const stopReasonLabel = (value?: string): string => !value ? "未返回" : Object.hasOwn(stops, value) ? stops[value]! : `其他结束原因（${value}）`;
export const TOKEN_HELP = "词元（token）是模型处理文本的计量单位，不等于汉字数；这里仅显示接口返回的用量，不代表账单。";
