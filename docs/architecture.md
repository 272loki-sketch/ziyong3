# 架构

梨园的核心是"一拍"：用户输入 → 主 Agent 写正文 → 原稿上屏 → 后台整理派生状态。本篇讲数据归属、一拍时序、两种模式、后台结算和附属补交。

## 数据：事实与派生

| 工件 | 是什么 |
| --- | --- |
| 会话树 / `rpNarrative` | **唯一故事事实**：当前分支已提交的正文与用户输入 |
| `rpAuthorDraft` / `rp-presentation-delivery` | 作者完整原交付，以及绑定正文 id 的显示引用 |
| `rp-supplementary-delivery` | 后台补出的附属格式（见[附属补交](#附属补交)） |
| `rp-state` | 场记账本：镜头内时间、在场角色 |
| `rp-world-*` / `rp-ecology-state` / `rp-npc-parallel` | 世界、镜头外生活、众生侧写采纳收据（见 [world-ecology](world-ecology.md)） |
| `rp-veridis-rewrite` | 显示润色投影（见 [plugins](plugins.md#veridis-显示润色)） |
| `rp-summary`、事件卡、`rp-outline`、提案 | 摘要与长期方向，不是已发生的事 |
| `rp-turn-settlement`、performance、请求记录 | 完成收据、耗时、实发请求 |

所有派生工件都绑定 session、卡和合法祖先来源，兄弟分支看不到；可以丢弃重建。未提交稿、专家报告、工具回执、候选都不是事实，用户明确输入和已存正文优先于任何派生参考。

## 一拍

```text
输入（绑定 mode）
→ 补上一拍必要的 pending 领域 + 来源守卫     失败：拒收本条，不落树，客户端保留草稿
→ 保存 user → ACK
→ 装配当前分支上下文 → direct / director 定稿
→ 保存 rpNarrative + rpAuthorDraft + 显示引用 + pending 收据
→ onAuthorReady（正文上屏）
→ 后台：各领域并发计算 → 来源守卫 → 串行落树、写收据
→ 释放共享写锁 → 处理队列中的下一条
```

- **三个完成点相互独立**：ACK = 输入已保存；`onAuthorReady` = 正文可读；`onTurnEnd` = 含后台的整拍结束。WS 用 `settling` 区分后两者，`timeToAuthorReadyMs` 和 `totalMs` 分开记。
- **模式跟着输入走**：排队、断线重放、重 Roll 都沿用提交时的模式。
- **写锁保持到后台结束**：期间可以继续发送，但只排队，出队后同样先补必要的 pending。
- **切会话、切卡、切真实分支**会让旧结果失效；只改设置元数据不算切支。
- **半稿如实标记**：作者真实截断或断流时标未完成，不冒充定稿，也不当成功拍写入记忆。
- **资料写操作延后**：作者要做的资料/面板写入在正文保存后才执行，取消就不执行。

## 两种模式

两种模式共用同一套资料装配、事实保存和后台结算。

**direct**：启用资料 + 当前分支 + 记忆/世界/生态的只读投影 + 文学导演候选 → 主 Agent 用普通文本写 → 交付。不另跑拍前生态或团队审稿。

文学导演候选只有一个来源：原数据库启用时，并入原生召回请求一起产出；数据库关闭（默认）时走独立的 `literaryDirector` 调用。候选缺失就降级，不再补发请求。

**director**：主 Agent 主持固定 3/2/2 流程：

```text
evidence  连续性 / 设定与知情 / 生活生态  三份报告
ideas     两个独立角度
writing   主 Agent 起草
review    事实 / 原始预设  两份审阅
decision  主 Agent 决定保留或改稿 → finalize
```

- 专家只交报告：同阶段互不可见，拿不到主 Agent 的完整 thinking，没有正文或定稿工具。失败的报告不能显示为"审阅通过"。
- 必须走完 review → decision → finalize 才触发 `onAuthorReady`。
- 每次生成只受理一次阶段转换。模型不支持原生工具时改用文本协议走完同一流程，不把 director 偷换成 direct。

旧 SDK 的无模式路径（`draft_append` 稿纸、`ask` 停点、Sogon/Sigon 周期画像）还在代码里，只为旧调用方和旧存档保留，Web 不可达，不要在上面加功能。

## 后台结算

后台领域：场记、世界、鲜活生态（含众生侧写）、原数据库、酒馆插件/MVU、Veridis，外加附属补交。各自按开关运行。

- **冻结输入，并发计算**：所有领域读同一份冻结的正文和拍前快照，并发跑，等全部退出（`allSettled`）。拍前账本只作参考，本拍正文优先。
- **串行落树**：计算完逐个复核取消、session/卡/分支、来源和 revision，再一个一个写进会话树。任何领域都不并发写树。
- **依赖只有少数几条**：酒馆插件/MVU 等附属补交退出后再解析；世界内部"提取 → 提案 → 审计"按顺序。其它领域互不等待。
- **失败留 pending**：失败或取消的领域留 pending，下一拍或手动恢复时按正文 id 和收据补，已完成的跳过。限流、超时、传输、格式错误做有界重试；认证、配额、内容拒绝不重试。参数见 `src/stage/engine.ts`、`src/stage/settlement-retry.ts`。
- **刷新**：后台结束只向匹配的 `entryId/entryScope` 发 `liyuan:turn-state-refreshed`，面板只读重查，不重跑卡脚本。

## 附属补交

卡或世界书要求输出某些格式（状态栏、选项、小剧场、变量更新块……），作者没交时，由一个独立的后台请求补上。这是"不设作者格式门槛"的另一半。

- **只补缺的**：按闭合成对标签判断作者是否已交。请求只带"要求输出且作者没交"的那几条资料（EJS 模板代码不算要求），不带设定正文和整本世界书。一条都没有就不发请求，记 skipped。
- **不改原稿**：补交结果存在专用条目里，不进事实、账本、世界/生态、数据库或记忆，也不复活已关闭的素材。
- **唯一例外是变量更新**：补交条目里含闭合 `<UpdateVariable>` 的，接在原稿后面交给 MVU 解析一次（原稿字节不变，见 [plugins MVU](plugins.md#mvu)）。如果要求里有作者漏交的变量更新，补交结果就必须带一条（数值不变也合法）；缺了先在同一次尝试内做一次结构化修复，仍缺就记 failed、走有界重试，MVU 保持 pending。纯显示的格式缺失不阻塞任何东西。
- **单独发布**：补交完成即保存并上屏，不等整批；整拍仍等它退出才释放写锁。
- **恢复顺序**：自动、手动和下一条输入前的恢复，都先补变量补交，再补酒馆插件/MVU；已完成的插件收据不重跑。

收据当前是 v4（按闭合成对标签判断，不分大小写，允许属性；开标签、自闭合、EJS 片段都不算交付）。v1–v3 只做显示兼容；恢复旧收据时按原版本重建输入、核对来源和 hash，再按 v4 生成新收据。收据版本和补交响应 JSON 里的 `version: 2` 是两回事。已保存收据在发布时不再检查"变量更新必须存在"，历史收据照常显示。

## 显示

正文与模型已返回的内容原样保存、先显示。显示层（正则、`rule_check` 隔离、`<options>`、Veridis 投影）只作用于显示副本，不回写原稿或事实，细节见 [materials 显示](materials.md#显示)。

## 模块地图

| 路径 | 职责 |
| --- | --- |
| `src/stage/engine.ts` | 输入、模式、排队、来源守卫、作者保存、后台结算、恢复 |
| `src/stage/agent-turn.ts` / `agent-director.ts` | 作者循环 / director 阶段与专家 |
| `src/stage/materials.ts` / `assemble.ts` | 预设、卡、分支历史、摘要、记忆装配 |
| `src/stage/literary-director.ts` | 文学导演（独立与合并两种） |
| `src/stage/literary-world-*.ts` / `literary-ecology.ts` / `npc-*.ts` | 世界、生态、众生侧写 |
| `src/stage/supplementary.ts` | 附属补交 |
| `src/stage/request-journal.ts` | 实发请求与 usage |
| `src/memory/` / `src/stage/compact.ts` | 旧记忆 |
| `src/outline/` / `src/plot-options/` / `src/novel-play/` / `src/research/` | 导演室、日常选材、小说开演、研究 |
| `src/tools/` / `.liyuan/extensions/roleplay.ts` | 工具与能力投影；扩展里的斜杠命令仍在用 |
| `server/main.ts` / `rest.ts` / `wire.ts` | 服务入口、REST、WS 协议 |
| `server/database-plugin-*` / `tavern-plugin-*` / `mvu-*` / `veridis-rewrite-*` | 原插件宿主 |
| `server/npc-sidewrite-http.ts` | 众生侧写设置与恢复接口 |
| `server/play-slots.ts` / `main-workspace.ts` | 多卡并行与主窗口接管 |
| `server/http-security.ts` / `src/access.ts` | Host/Origin 守卫、访问密码 |
| `web/src/` / `web/public/` | 界面 / 插件宿主静态文件（服务运行时读取） |
| `packages/` | 本地 SDK fork（应用读其 `dist`） |
| `skills/` | 内置 Skill；用户私人覆盖在 `.liyuan-stage-skills/` |

## 改引擎时

先说明改动为什么仍满足：单作者、固定 3/2/2、原稿先行、冻结输入、串行落树、恢复不重复。回归以 `test/generation-mode-engine.test.ts` 为主，覆盖两种模式、慢后台、排队、半稿、取消、切支、重 Roll、缺收据。
