# 模型连接与岗位配置

模型连接、默认作者和岗位覆盖是不同设置。目录只反映当前启用配置；保存在配置仓库但未启用的渠道不会自动成为可调用连接。切换默认模型后，应同时核对 `stepModels`，避免岗位覆盖仍指向旧模型。

## 配置原则

- 作者、专家、世界、生态、记忆、研究和变量解析按各自配置解析，不统一替换为一个模型。保留已有 Gemini Flash 等岗位分工。
- 保存启用配置时以当前完整启用范围为基底，保留其它 provider、默认模型、岗位、开关和未知兼容字段；不能用旧单渠道副本覆盖运行配置。
- Luna 旧名迁移的目标是 `gpt-6-luna`。模型 ID 必须由实际端点支持，不能仅修改名称就认定可用，也不能为连接失败自动启用旧渠道。
- 聊天模型和嵌入连接独立配置。更换作者不自动更换填表、召回、MVU 或向量模型。
- 配置示例只使用占位符。API Key、OAuth、私有网关地址和完整运行配置不进入公开文档或提交。

## 工具调用能力

连接页为每个模型提供“支持工具调用”开关。新模型默认支持；已明确关闭的配置不会自动开启。

| 入口 | 保存行为 |
| --- | --- |
| 当前生效 | 直接保存当前模型能力；有启用配置仓库时同步该仓库 |
| 配置仓库 → 修改 | 逐模型修改；启用仓库保存时同步运行配置，未启用仓库不激活 |
| 配置生成器 | 逐模型声明能力；生成或保存不自动启用、不切换当前模型 |

字段为 `providers.<渠道>.models[].compat.supportsTools`。模型级值优先于渠道级值，两级都未配置时默认支持。重新勾选写入模型级 `true`，不删除渠道其它兼容参数。正在运行的一拍继续使用已捕获配置。

关闭能力只禁用该模型的原生工具协议：请求不附 `tools` / `tool_choice`，不先制造失败再探测。它不改变模式或岗位；director 仍执行固定三证据、双角度、双审阅，由同一作者通过既有文本流程定稿。依赖原生工具的资料读取、MCP 或媒体操作不会被伪装为已执行；结算旁路仍使用自己的岗位配置。

该开关是用户声明，不是自动能力测试。认证、配额、schema、参数和网络错误不等于“不支持工具”。保存失败会报错；响应丢失时重读真实保存状态，不显示未经确认的成功。

## 独立插件岗位

| 配置 | 用途 | 失败边界 |
| --- | --- | --- |
| `stepModels.npcParallel` | 原 NPC 候选、生态接入和有界 schema 修复 | 缺失或不可用明确失败，不借用主演或通用恢复模型 |
| `stepModels.veridisRewrite` | 原规则命中的局部显示润色 | 缺失或不可用不回退作者；显示保留原稿 |
| `stepModels.mvuParse` | 原 MVU 的受管额外解析 | 必须匹配已配置连接及受信任来源，不回退正文写手 |

NPC 与 Veridis 各自使用独立岗位；Gemini 3.8 Flash 可按对应配置承担这些职责，不意味着其它 Flash 岗位应迁移。插件自定义 Key 和任意端点不作为受管传输入口；凭据由服务端连接提供，公开状态不下发真实 Key。允许的 temperature 经受管通道传递。

NPC 和 Veridis 每 session/card/source 各有八次持久请求额度，彼此独立，也不同于作者轮数。NPC 的生成、生态接入、修复共用其额度；MVU 使用酒馆助手的辅助调用额度。失败尝试不退款，重启不清零。attempts、供应商 usage 和墙钟分别记录；缺 usage 不虚构零 token。详见 [NPC](NPC-PARALLEL.md)、[Veridis](VERIDIS-REWRITE.md)、[MVU](MVU.md)。

## 传输与诊断

连接能力应由端点文档、明确兼容配置或隔离的原生请求核验，不只看模型家族名。未知 `reasoning_effort`、角色或 schema 参数不强开。

1. 核对当前启用 provider、默认作者和具体岗位引用，先排除未激活配置或旧覆盖。
2. 区分认证/配额、参数/schema、工具协议和网络错误；HTTP 200 也可能携带流内失败。
3. 区分首字等待、流中静默、单流上限和整拍预算。提高整拍预算不能修复代理空闲超时。
4. 代理保活应覆盖返回流之前的等待和流中静默，并即时 flush；CLI Proxy 兼容修复使用每 15 秒的 SSE 注释/非流式空白保活，这些字节不进入正文。保活不能消除供应商真实截止或配额限制。
5. 需要验证时使用合成短请求，单独报告完成原因、文本、工具回执和实际 usage；不能把探针成功当生产文学质量或所有兼容行为通过。

Git 下载代理与模型传输不是同一配置。NPC/Veridis 专属 Git 路由只影响来源更新，见 [酒馆插件](TAVERN-PLUGINS.md#两新来源的专属git路由)。

## 源码与验证

入口为 `src/configured-models.ts`、`src/model-routing.ts`、`server/rest.ts`、`src/stage/engine.ts`、`src/stage/agent-turn.ts` 和 `web/src/` 的连接设置组件；具体兼容传输还涉及 `packages/` 中的 runtime/API 实现。插件路由分别见 `server/npc-parallel-runtime.ts`、`server/veridis-rewrite-runtime.ts` 和 `server/tavern-plugin-runtime.ts`。

预算见 [PROMPT-BUDGETS](PROMPT-BUDGETS.md)，请求错误语义见 [WRITER-API-COMPATIBILITY](WRITER-API-COMPATIBILITY.md)，实发载荷与用量见 [REQUEST-INSPECTOR](REQUEST-INSPECTOR.md)。测试命令和覆盖范围以 [TESTING](../TESTING.md) 为准；离线回归不证明真实端点可用。
