# 双模式提示词来源与适配记录

## 来源

七份 `skills/导演*/SKILL.md` 对照、翻译并适配 Luker Team 的 v2.8.0 提示词与方法 Skill。参考版本 commit：`e25115a572b9c3a85af5a3a29b9098f9b46d80c7`。

来源仓库：`github.com/funnycups/Luker`。主要来源文件：

| 梨园 Skill | Luker 来源 |
| --- | --- |
| 导演证据整理 | `default/skills/global/chat-scout-method-zh/SKILL.md` |
| 导演设定核对 | `intent-scout-method-zh`、`lorebook-scout-method-zh`、`epistemic-scout-method-zh` |
| 导演生态参考 | `notes-pickup-scout-method-zh` 的相关性筛选方法，结合梨园现有生态与世界材料 |
| 导演角度构思 | `plot-brainstormer-method-zh` |
| 导演事实审阅 | `continuity-critic-method-zh` |
| 导演预设审阅 | `voice-critic-method-zh` 的具体用法判断、人物表达及创作框架泄漏检查方法；尺度改为用户原始预设与明确人设 |
| 导演主Agent | `director-turn-workflow-zh`、`notes-curator-method-zh`；`public/scripts/extensions/orchestrator/director-default-prompt.js` |

上表未展开的原始方法均位于 `default/skills/global/<名称>/SKILL.md`；角色边界另对照 `public/scripts/extensions/orchestrator/director-defaults.js`。这七份改编提示词保留已有的上游 Luker Team 署名及 `AGPL-3.0-only` 许可标记，完整官方许可原文见 [Luker AGPLv3](../licenses/Luker-AGPL-3.0.txt)，组件声明见 [许可说明](../licenses/README.md)。

主项目的 [LICENSE](../LICENSE) 为 PolyForm Noncommercial 1.0.0，不能用它覆盖这些 AGPL 组件的许可，也不能将组件声明视为整个项目改用 AGPL。提供许可文本和署名不代表已经确认 AGPL 与 PolyForm 的组合兼容、全部再分发义务或网络服务义务已经满足；发布前仍须独立审查具体组合及许可要求，未解决的许可冲突不能凭本说明放行。

## 适配而非整套搬运

- 保留阶段隔离、同阶段并行、角度型简报、唯一正文作者、默认信任草稿、无问题无需修改、未采用候选不记入事实。
- 将 Luker 动态专家集合收敛为梨园固定的三证据、双角度、双审阅；不区分日常/爆发的流程长度。
- 使用梨园现有记忆、原始卡、人设、原著资料、世界画像/Manifest、生态、导演室与研究库；不另开心理画像。
- 普通文本写作而非继承上游 `write_message`；工具名适配梨园阶段收据、定点改稿及 `finalize`。
- 报告采用梨园带来源 ID 的 JSON 协议；来源 ID 可核对不等于语义已经证明。
- 传短的已完成报告与实际检索回执，不传主 Agent 完整 reasoning；专家报告不是新的事实源。
- 不继承通用禁词表、强制人物温热内心、固定转折/事件/关系进度、必须读额外文风 Skill 等要求。审阅依据仍为用户原始预设及明确人设。

`主演文本直出` 是梨园普通文本通道协议，不另造小说写法；直出的正常 Stitches 文学导演仍使用原来的模型插头、结果字段和职责，将旧画像引用换成原始资料，去掉旧系统层默认时间冻结；新模式的资料标题也不再把写作者指定为某个 NPC 的扮演者。

## 梨园执行协议

来源声明之外的单一事实权威、来源 ID/回执、原作者交付和取消恢复由梨园执行协议负责，不新增文学尺度、主角权限或固定结尾。六专家报告的来源核验不等于语义证明，原卡与预设仍决定写法和格式。

`主演文本直出` / `导演主Agent` 要求正文与卡格式由同一作者一并交付，不等待拍后补交。历史 `卡格式需求识别`、`卡格式完整交付`、`主作者正文边界` Skill 保留兼容来源，但新两模式不自动执行，不请求作者边界 JSON 或设置卡格式门槛；`原生工具协议修复` 属于工具错误处理而非文风规则。详见 [FORMAT-DELIVERY](FORMAT-DELIVERY.md)。

`剧情记忆摘要` 及作者/证据整理 Skill 的记忆合同关注主要人物经历、已解决重要事件、具体查询锚点、来源与概括、角色知情边界。`src/scribe.ts` 负责十节摘要初建/增量结构及来源映射，不强制每拍查询或新增剧情方向。启用原数据库后旧自动记忆路径停止，详见 [PLAN-RP-MEMORY](PLAN-RP-MEMORY.md)。

内置工作流提示词位于 `skills/*/SKILL.md`；私人 `.liyuan-stage-skills/` 覆盖优先，不随版本被替换。修改流程协议不能借机改原预设、卡或用户文风。保留上游署名与许可，不能以新增适配抹去来源。

## 请求观测与原 MVU

请求查看器参考 Luker 的交互与观测分工，实发载荷/逐次回执存储由梨园独立实现，不复制其请求存储代码，也不改变专家职责。该参考不构成另一个生成框架，见 [REQUEST-INSPECTOR](REQUEST-INSPECTOR.md)。

原 MagVarUpdate（MIT）、artifact 许可说明及 StageDog MVU-zod 桥（PolyForm Noncommercial）是分别授权的原脚本依赖，由原酒馆助手运行、固定字节和哈希，不是新的正文作者 Skill。只有明确启用的 MVU/schema 依赖加载，其它卡自动化和关闭模块不自动开启。精确来源与支持范围见 [MVU](MVU.md)。
