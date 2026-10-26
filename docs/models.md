# 模型与工具

梨园把"谁来调用模型"拆成一组岗位。哪个模型坐哪个岗位，取决于用户手上有哪些 API；文档不推荐模型，过去的探针结果也不作参考。本篇讲岗位解析、配置保存、工具能力、失败分类、预算和权限。

## 岗位

岗位清单的唯一来源是 `src/model-routing.ts` 的 `SIDE_MODEL_STEPS`，配置写在 `stepModels.<岗位>`，每项是 `{ provider, id }`。

| 岗位 | 用途 | 未配置时 |
| --- | --- | --- |
| `writer` | 主 Agent 写正文 | 当前会话模型（小说开演卡始终用它） |
| `literaryDirector` | 记忆召回 / 剧情推进 / 文学导演统一入口 | 当前会话模型 |
| `directorSetting`、`directorIdeas`、`directorReviewFacts`、`directorReviewStyle`、`literaryContinuity`、`ecologyRuntime` | director 的证据、角度、审阅专家 | 当前会话模型 |
| `scribe` | 场记账本 | 拍后结算用当前会话模型；**单独补写账本**必须显式配置 |
| `literaryWorld`、`literaryWorldFacts`、`literaryWorldAudit`、`worldProfile` | 世界推演、事实提取、审计、世界画像 | 当前会话模型；`worldProfile` 已配置但不在当前连接时报错 |
| `ecologySearch`、`ecologyGlobal`、`ecologyCard` | 鲜活生态 | 当前会话模型 |
| `literaryCharacter`、`literaryPersona` | 旧周期画像 | 当前会话模型 |
| `memoryEvents`、`compaction` | 旧记忆事件卡、压缩 | 当前会话模型 |
| `plotAdaptation`、`sceneConductor` | 选材改编、场面调度 | 当前会话模型 |
| `outlineChat`、`outlineBootstrap`、`outlineReconcile`、`outlineAudit`、`outlineResearch` | 导演室 | 当前会话模型 |
| `outlineCorpusResearch`、`novelDigest` | 导演检索、长文消化 | 先用 `outlineResearch`，再用当前会话模型 |
| `presetSort` | 预设 AI 分拣 | 当前会话模型 |
| `dailyPlot`、`npcParallel`、`veridisRewrite`、`mvuParse` | 日常筹备、众生侧写、Veridis、MVU 额外解析 | **明确失败**（`mvuParse` 还须精确匹配当前连接） |

岗位之外还有三项独立配置：系统助手 `assistantModel`（未配置时跟随当前会话模型）、原数据库拍后填表 `fillModel`、记忆嵌入。它们都不随主演变化。

解析规则：

- **每个岗位独立**。更换主演不影响任何其它岗位、填表、嵌入或助手。
- **四个严格岗位**（`dailyPlot`、`npcParallel`、`veridisRewrite`、`mvuParse`）和单独补写账本只用显式配置，缺了就报错，不借用其它模型（原因见 [decisions](decisions.md#8-模型岗位独立不借用主演)）。
- **其它岗位找不到目标连接时**：先按 provider+id 精确匹配，再按 model id 唯一重定位，仍找不到才回到当前会话模型并发警告。不为补绑定去启用旧渠道。
- **`literaryDirector` 与原数据库同步**：保存时把它镜像为数据库的召回模型和相关配置，数据库那边不能另设不同的召回模型（见 [memory](memory.md#原数据库插件)）。
- **`analysisRecoveryModel`** 是用户显式选的恢复路由，只用于普通旁路的第二次尝试；后台结算、严格岗位和 `worldProfile` 不走它。

## 保存配置

模型连接、默认作者和岗位覆盖是三类设置。连接目录只反映当前启用的配置；配置仓库里未启用的渠道不可调用。

- 保存以当前完整启用配置为基底，保留其它 provider、默认模型、岗位、开关和未知兼容字段，不用旧的单渠道副本覆盖。只有用户明确移除渠道，依赖它的岗位才会失效。
- 切换主用模型只改默认作者，`stepModels` 原样保留。
- 岗位选择立即保存（受工作区保护），关闭面板不取消；失败保留错误、不自动重放。主窗口与独立卡位各自保存。
- 插件不能用自填 Key 或任意端点作为传输通道；凭据由服务端连接提供，公开状态不下发真实 Key。
- 示例只用占位符；Key、OAuth、私有网关地址不进文档或提交。

## 工具能力

工具能力是逐模型的用户声明，不是自动探测：`providers.<渠道>.models[].compat.supportsTools`，模型级优先于渠道级，都未配置视为支持。在"当前生效"、"配置仓库 → 修改"、"配置生成器"三个入口都能逐模型改；生成器和未启用仓库的修改不会切换当前模型。

- 用户明确关闭的不会被自动打开；正在运行的一拍沿用开拍时的配置。
- 关闭后请求不附 `tools`/`tool_choice`，director 改用文本协议走完同一流程。依赖原生工具的资料读取、MCP、媒体操作显示为未执行。
- 只有显式 `supportsTools=false` 或供应商明确拒绝工具才走文本流程。认证、配额、schema、参数组合、网关超时都单独诊断，不归为"不支持工具"。
- 专家本来就不带业务工具、只返回结构化报告，这不是降级。
- 流式与否按 `compat.streaming`；未知的 `reasoning_effort`、角色或 schema 参数不强开。

## 失败分类

失败分两层记录：`src/stage/model-failure.ts` 的 `kind`（auth / model / quota / rate-limit / timeout / transport / format / content-filter / unknown）和 `src/stage/request-failure.ts` 的 `origin`（`local-timeout` / `cancelled` / `provider` / `sdk`）。

- 本地预算到期、主动取消、供应商 HTTP 错误、未拿到 HTTP 状态的 SDK/传输失败分开记录；本地超时不写成"用户取消"。
- HTTP 200 也要解析流内错误；空文本或只有 thinking 的终态记失败。
- 供应商明确的内容拒绝单列为 `content-filter`，不借恢复模型绕开。
- 认证、模型不可用、配额、内容拒绝是永久失败，不重试；限流、超时、传输、格式可有界重试（`src/stage/settlement-retry.ts`）。不为躲失败换模型或启用旧渠道。
- 迟到结果不采纳，必要领域留 pending；已完成的终态保留原稿和 usage。

## 预算与超时

预算是执行和费用边界，不是写作要求。触限时保留未完成收据，不静默定稿。数值以代码为准：

| 边界 | 位置 |
| --- | --- |
| 整拍预算（按模式默认，`generationTimeoutMinutes` 可覆盖）、单条作者流上限 | `src/stage/engine.ts` |
| 作者轮数、研究调用数 | `src/stage/agent-turn.ts` |
| 单次分析/结算/旁路（`analysisTimeoutMinutes`） | `src/request-budget.ts` |
| 历史与资料裁剪、输入容量预检 | `src/stage/prompt-budget.ts`、`context-preflight.ts` |
| 后台重试间隔与次数 | `src/stage/settlement-retry.ts` |

- 整拍预算和单次请求预算分别生效。
- **首包等待、流中静默和整拍预算是三个问题**，加大整拍预算修不了传输没有心跳。部分供应商在隐藏推理期间不发流式字节，部分前置代理会因首包/空闲超时断开（如 524）；阈值和行为要按端点实测。若实测同一端点同一模型支持 `openai-responses` 且事件能及时穿过代理，可只为对应岗位改绑这个协议渠道作为绕行（操作见[运维](../deploy/VPS-OPERATIONS.md#模型代理超时)），不保证普遍有效。模型条目的 `reasoning: false` 只影响 SDK 构造请求，不是发给供应商的"关闭推理"指令。
- 容量预检只提示，不静默截断正文或预设。被裁掉的资料不能通过引用验证。
- 众生侧写、Veridis、助手/模板/MVU 的请求次数按 session/卡/来源持久累计，失败也计数，重启不清零，没有宿主硬上限。
- attempts、usage、墙钟分开记；usage 缺失记"未知"。
- 测试不得偷偷缩短 `analysisTimeoutMinutes` 再把本地超时当成 API 错误。

## 权限

`src/tools/` 定义统一的工具契约，`src/tools/adapters/stage.ts` 按主 Agent / 系统助手投影能力。

- 主 Agent 可用检索、来源核对、记忆、媒体和已授权外设；director 另有阶段协调工具。专家只返回报告。
- 资料/面板写操作在正文保存后执行，取消不执行。世界书写回带来源、身份、行键，agent 补充不改原卡（见 [materials](materials.md#世界书)）。
- 故事里的行为不是现实授权：付款、删除、发帖、本机命令、MCP 各自保留能力和授权检查，不因剧情放宽。
- 系统助手是独立会话，做诊断、配置、导入和外部服务，不是第二个正文作者。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `src/model-routing.ts` / `src/configured-models.ts` | 岗位清单与解析 / 当前启用连接 |
| `src/stage/engine.ts` / `agent-turn.ts` | 主演解析、旁路、恢复路由 / 作者轮数与工具协议 |
| `src/request-budget.ts` / `src/stage/model-failure.ts` / `request-failure.ts` | 本地截止与失败分类 |
| `server/rest.ts` / `server/main.ts` | 配置保存、旁路调用 |
| `web/src/model-tool-support.ts` / `components/ConnectPanel.tsx` / `SettingsPanel.tsx` | 工具能力与岗位设置界面 |
| `src/tools/` / `src/stage/tools.ts` / `mcp-stage.ts` | 工具契约与权限 |
