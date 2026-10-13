# 当前文档导航

本导航只收录批准公开的长期介绍、使用与开发维护指南，不收录验收、研究实施、审计、交接或版本历史。源码版本以 manifest 为准，实际服务和发布状态分别核验；某次本机部署或 Git 合并不证明当前公开 Release。本地验收记录不随公开仓库发布。

## 第一读

1. 用户从 [README](../README.md) 开始，开发维护先读 [AGENTS](../AGENTS.md)。
2. [架构](ARCHITECTURE-OVERVIEW.md)说明事实与派生工件，[项目结构](PROJECT-STRUCTURE.md)说明源码、构建和私有数据的目录边界。
3. [两模式](GENERATION-MODES.md)说明作者职责，[执行合同](PLAN-ROUND-FLOW.md)说明提交、先交付、后台、取消与恢复。
4. 按任务阅读下表主题；涉及导演室须读 [DIRECTOR-ROOM](DIRECTOR-ROOM.md)，涉及会话或思考记录先读 [READING-THINKING](READING-THINKING.md)。
5. 修改后按 [TESTING](../TESTING.md)选择门禁，公开同步与发行按[发布流程](BRANCH-RELEASE-WORKFLOW.md)。

## 现行主题

| 主题 | 指南 |
| --- | --- |
| 正文就绪与后台结算 | [执行合同](PLAN-ROUND-FLOW.md#前台交付与后台完成)、[恢复与诊断](RECOVERY-AND-DIAGNOSTICS.md) |
| 原作者交付、卡格式与正则 | [格式交付](FORMAT-DELIVERY.md)、[预设边界](PRESET-SPLIT-TAXONOMY.md) |
| 实发提示词、逐次耗时与用量 | [请求查看器](REQUEST-INSPECTOR.md) |
| 模型连接、工具支持与预算 | [模型](MODEL-CONNECTIONS.md)、[预算](PROMPT-BUDGETS.md)、[作者 API 兼容](WRITER-API-COMPATIBILITY.md) |
| 卡内及独立世界书 | [世界书](LOREBOOKS.md) |
| 世界状态与鲜活生态 | [世界](PLAN-WORLD-ENGINE.md)、[生态](PLAN-LIVING-ECOLOGY.md) |
| 原数据库与旧记忆回退 | [原数据库插件](DATABASE-PLUGIN.md)、[旧剧情记忆](PLAN-RP-MEMORY.md) |
| 酒馆助手与提示词模板 | [原插件宿主](TAVERN-PLUGINS.md) |
| MVU 变量及管理界面 | [MVU](MVU.md) |
| NPC 场外侧写与统一采纳 | [NPC Parallel](NPC-PARALLEL.md) |
| 可选显示润色与再分发限制 | [Veridis Rewrite](VERIDIS-REWRITE.md) |
| 权限和工具能力投影 | [工具](PLAN-RP-TOOLING.md) |
| 只读定位、取消与恢复 | [记录阅读](READING-THINKING.md)、[恢复与诊断](RECOVERY-AND-DIAGNOSTICS.md) |
| 导演室与长期方向 | [独立对谈](DIRECTOR-ROOM.md#创作对谈与续聊)、[大纲](PLAN-OUTLINE-SYSTEM.md) |
| 自主搜索与原著证据 | [Agentic Research](AGENTIC-RESEARCH.md) |
| 小说消化与开演 | [长文消化](PLAN-NOVEL-DIGEST.md)、[小说开演](NOVEL-PLAY.md)、[开演架构](ARCHITECTURE-NOVEL-PLAY.md)、[开演维护](NOVEL-PLAY-MAINTENANCE.md) |
| 历史图片与生图退役 | [退役边界](IMAGE-GENERATION-RETIREMENT.md) |
| Skill 与方法来源 | [整合边界](STANDALONE-INTEGRATION-BASELINE.md)、[提示词来源](PROMPT-SOURCES.md)、[第三方信用](THIRD-PARTY-INSPIRATION.md) |
| 仓库结构与隐私审计 | [项目结构](PROJECT-STRUCTURE.md)、[隐私与公开流程](PRIVACY-AND-PUBLISHING.md)、[测试](../TESTING.md) |
| 升级、同步与发布 | [运维](../deploy/VPS-OPERATIONS.md)、[发布流程](BRANCH-RELEASE-WORKFLOW.md)、[本地与上游同步](LOCAL-UPSTREAM-UPDATES.md) |

## 搜索研究当前状态

研究使用既有主作者工具循环，不是第三种正文模式。普通直出按需核查，导演通过既有 sources 接收真实已读、来源有效的证据；参考 runner 不代表生产作者路径。日常使用、网络隔离、预算与限制以 [Agentic Research 指南](AGENTIC-RESEARCH.md)为入口。

## 公开文档用途

[README](../README.md)用于产品介绍和入门，上表主题指南用于日常操作、职责与兼容边界；[测试指南](../TESTING.md)用于可重复的验证方法，[隐私与公开流程](PRIVACY-AND-PUBLISHING.md)用于公开候选审阅。公开文档不充当部署日记、测试日志或报告下载页，也不发布 Word 文档、截图和文档图片。

每次验收在本地独立记录代码基线、命令、fixture、pass/fail/skip、真实模型使用及未覆盖范围；失败、超时、缺 fixture 和未知 usage 不因后续成功而抹去。本地验收记录不随公开仓库发布，也不能替代现行执行合同。Git 合并、合成测试和单题模型成功都不证明全部原著研究质量通过。
