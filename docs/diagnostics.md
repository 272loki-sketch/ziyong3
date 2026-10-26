# 排障

顺序：先确认是哪一拍，再看它停在哪个完成点，然后读收据和实发请求，最后才看原文。三个完成点与恢复规则见 [architecture](architecture.md#一拍)，失败分类见 [models](models.md#失败分类)。

## 先定位

- **用真实 id**：当前 WS hello 或显式会话 id、session/卡、输入 id、正文 entryId 和祖先链。不用文件 mtime 猜"最新"——换模型、重命名、设置更新都会改 mtime。
- **时间**以 JSONL 条目自身的 timestamp 为准，换算时区后再和用户说的时刻比对；对不上就问，不猜是哪一局。
- 用 user 父节点、assistant 正文 id 和祖先链区分新输入、重 Roll 与兄弟分支。隔离测试的记录不是生产会话。
- 只需状态、次数、耗时时，读收据和计数，不展开正文或 thinking。公开报告只写脱敏的错误类别、时间和状态。

## 一拍卡在哪

| 现象 | 所在阶段 | 看什么 |
| --- | --- | --- |
| 没有 ACK，输入框保留草稿 | 受理前：上一拍必要恢复或来源守卫失败 | 上一拍的 pending 收据与错误；修好后重发，本条未落树 |
| 有 ACK、没有正文 | 作者阶段 | `rpGenerationWorkflow`、请求查看器；director 是否走完 review → decision → finalize |
| 正文已上屏，显示 settling | 后台结算 | 各领域收据；settling 只表示后台在整理，作者已交稿 |
| 整拍结束但某个面板没更新 | 某领域 failed/pending | 该领域收据的来源、revision 与错误类别 |
| 正文标未完成 | 作者真实截断/断流/触限 | 作者终态原因与预算；半稿如实保留 |

- 逐领域查 complete / pending / failed / skipped，并核对来源与 revision。缺工件记未知。
- 断流、超时或关掉面板后，先重读持久状态和实发请求再决定。界面停止等待后服务端可能仍在执行，盲目重试可能重复收费。
- 重 Roll 失败只有在没有新回复落树时才回退。

## 恢复入口

恢复只补合法来源缺失的领域，已完成的跳过。

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 恢复后台结算 | `POST /api/turn/retry-settlement` | 补当前正文缺失的领域，有界重试 |
| 补写 / 确认账本 | `POST /api/state/retry-ledger`、`confirm-ledger` | 见 [world-ecology 场记账本](world-ecology.md#场记账本) |
| MVU 单独恢复 | `POST /api/mvu/recover` | 只针对当前完整交付 |
| 众生侧写补采纳 / Veridis 重试 | `POST /api/turn/retry-npc-admission`、`retry-veridis` | Veridis 失败时继续显示原稿 |
| 重新生成附属补交 | `POST /api/turn/regenerate-supplementary` | 不改原稿 |

附属补交和 MVU 是两个领域，要分别看收据：要求里有作者漏交的变量更新时，补交没完成会让 MVU 等待；先恢复补交，再恢复 MVU。补交 complete 不代表变量已保存。

## 读会话记录

| 位置 | 内容 |
| --- | --- |
| `~/.liyuan/agent/sessions/<编码后的工作目录>/` | 主窗口会话 JSONL（会话树） |
| `<仓库>/.liyuan/play-slots/<id>/work/agent/` | 独立卡位的 agent 目录 |
| `<仓库>/.liyuan/request-journal/` | 实发请求记录，按会话/卡隔离 |

没有会话转储脚本，直接逐行读 JSONL。常用字段：

| 字段 | 含义 |
| --- | --- |
| `rpGenerationMode` | 该输入/正文用的 direct 或 director |
| `rpGenerationWorkflow`、`rp-turn-performance` | 阶段、作者轮数、调用与耗时 |
| `rpNarrative` / `rpAuthorDraft` | 故事事实 / 作者完整原交付 |
| `rp-presentation-delivery`、`rp-supplementary-delivery` | 显示引用 / 附属补交 |
| `rp-turn-settlement`、`rp-turn-diagnostic` | 领域收据 / 失败与跳过诊断 |
| `rpTimeline` | 旧稿纸路径的记录，新模式不用 |

最终 message 里的 thinking 只是那一次调用的；专家和各轮作者的思考在各自的请求记录里。

## 请求查看器

主界面"提示词查看器"列出当前会话、卡和合法祖先上已观测的真实请求，可按模型、阶段、状态、轮次 id、请求 id 搜索，查看最终消息、工具、采样参数和完整 JSON，或下载单条。REST：`GET /api/request-inspector[?id=…]`。

- **记录的是什么**：SDK `onPayload` 捕获的最终 API 载荷。装配预览或事后重组的内容不称实发；没有最终载荷的标"只有 SDK 上下文"。
- **传输时间线**（`openai-completions`）：`transportStarted` 只表示进入 fetch，`responseHeaders` 才是实际 HTTP 状态，`firstByte` 与 `firstEffectiveDelta` 区分保活/空事件和有效输出。`failure.statusCode` 可能来自错误文本分类，以 `transport.responseHeaders.status` 为准。只存有界的 `x-request-id` 和端点 SHA-256，不存鉴权头。`openai-responses` 适配器还没接入这条时间线，缺 `transport` 不能说明没发请求。
- 首个增量到达即持久化，运行中也能查；单次耗时、首增量、端到端、并发阶段分开显示，并发耗时不相加。重启后缺结束回执的标为中断。
- token 按供应商回执保存；缺回执（含 SDK 默认全零）标缺失，不估算。
- 数据库请求区分 `database.before`（拍前召回）与 `database.after`（拍后整理）；与文学导演合并时显示为"记忆召回 / 剧情推进 / 文学导演"。MVU 额外解析是 `mvu.parse`。
- **覆盖**：主作者、专家、拍前与后台结算、导演室/研究旁路、助手候选、数据库模型与向量请求。系统助手自身的多轮、媒体模型、供应商隐藏重试不在其中。
- 只能看当前会话、卡和可见祖先的请求，不能凭 id 读兄弟分支。目录 0700、文件 0600，按会话/卡有保留上限（`src/stage/request-journal.ts`）。下载内容仍是私人数据。

要证明某个派生结果被下一拍用上了：在下一拍的实际 payload 里找到那条经过来源筛选的参考，再看作者正文。只有报告或面板更新不能证明采纳。

## 常见问题

| 症状 | 先看 |
| --- | --- |
| 发送后输入还在、没 ACK | 上一拍 pending 恢复失败的原因 |
| 一直 settling | 哪个领域还在跑或卡在重试；请求查看器里对应 phase |
| 账本没跟上正文 | 账本面板状态与 `rp-turn-diagnostic`；内容拒绝不会自动重发 |
| 显示少了一段 | 比对 `rpAuthorDraft` 与显示，再用正则查看器（见 [materials](materials.md#显示)） |
| 变量/MVU 没变 | MVU 收据与 `mvu.parse` 请求；补交里有没有闭合的变量更新块 |
| 报"不支持工具" | 是否真的 `supportsTools=false` 或供应商明确拒绝；否则按认证/schema/传输查（见 [models](models.md#工具能力)） |
| 插件岗位报"未配置" | `stepModels` 中对应的严格岗位 |
| 超时 / 524 | `failure.origin`：`local-timeout` 看阶段预算；`provider` 看实际 HTTP 状态；首包/空闲超时见 [models 预算与超时](models.md#预算与超时) |
| usage 是空的 | 供应商没回执，按未知处理 |
| 众生侧写 / 生态 pending | 侧写收据与生态接入错误（见 [world-ecology](world-ecology.md#众生侧写)） |
| 记忆没写入 | 记忆后端的收据与 scope（见 [memory](memory.md#排障顺序)） |
| 插件概览"读取失败" | 显式刷新；未知不当已关闭或已完成 |
| 设置保存结果不确定 | 先重读服务端状态，保留草稿，确认来源后再保存 |
| 导演室有流式文字但没有保存确认 | 查持久对谈；没有 `done` 不算成功 |

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `src/stage/engine.ts` / `settlement-retry.ts` | 排队、作者交付、写锁、领域恢复 / 有界重试 |
| `server/main.ts` / `wire.ts` / `rest.ts` | 投递、WS 状态、恢复接口 |
| `src/stage/request-journal.ts` / `server/request-inspector.ts` / `web/src/components/RequestInspector.tsx` | 请求记录与查看器 |
| `src/stage/performance.ts` | 耗时投影 |
| `src/paths.ts` / `server/play-slots.ts` | agent 目录与卡位工作目录 |
