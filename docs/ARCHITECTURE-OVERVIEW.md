# 梨园当前架构

梨园以分支会话树保存故事，由单主 Agent 完成正文。Web 只有 `direct` 与 `director` 两种正文模式；导演室、研究、专家和插件不构成额外作者。本文描述模块责任与数据合同，执行顺序见 [PLAN-ROUND-FLOW](PLAN-ROUND-FLOW.md)，物理目录与隐私边界见 [PROJECT-STRUCTURE](PROJECT-STRUCTURE.md)。

## 1. 唯一事实与派生工件

| 工件 | 责任 |
| --- | --- |
| Session Tree / `rpNarrative` | 当前分支已提交的故事与用户输入，是故事权威 |
| `rpAuthorDraft` / `rp-presentation-delivery` | 完整作者原交付与绑定正文 id 的显示引用，不是第二份故事 |
| `rp-state` | 镜头内角色账本；磁盘状态仅是缓存 |
| `rp-world-manifest/state/audit` | 世界适配版本、状态与转移审计 |
| `rp-ecology-state` | 镜头外生活、事件、认知与传播；候选经统一采纳才可进入状态 |
| `rp-npc-parallel` | 正文来源、人物、上游 commit 和候选 hash 绑定的采纳收据，不是正文 |
| `rp-veridis-rewrite` | source/原稿 hash 绑定的可选显示投影及收据，不改故事事实 |
| `rp-summary` / 事件卡 / 归档 | 接力摘要、来源定位与细节，不覆盖原文或已确认状态 |
| `rp-outline` / 提案 / 对谈 | 长期方向与候选，不等同已发生事实 |
| `rp-turn-settlement` / performance / request journal | 完成收据、耗时与实发请求观测，不证明文学质量 |

未提交稿、专家报告、工具回执、候选和布局都不是故事事实。派生工件必须绑定会话、卡和合法祖先来源；兄弟分支不可见。用户明确输入与已保存正文高于派生参考。恢复使用正文 id 和领域收据，不重复已完成事实。

## 2. 一拍

```text
输入绑定模式 → 必要 pending 恢复与来源守卫（失败则拒绝、草稿保留）
→ user 持久化与 ACK → 捕获当前分支上下文 → direct 或 director 单作者定稿
→ 保存规范正文、完整原稿、绑定交付与 pending → onAuthorReady
→ 启用的后台领域并发计算 → 来源检查 → 串行落树与收据
→ 完整运行结束、释放共享写锁 → 下一拍
```

`direct` 使用已有世界/生态的只读投影与正常文学导演，不增加拍前生态生成或团队审稿。`director` 固定三份证据、两个角度、主稿、两份审阅、主作者决策和定稿；同阶段专家不互看，不接完整主作者 thinking。

两模式共享原始启用预设、卡格式、事实保存和后台结算，不按“日常/关键回合”切换另一套机制。ACK、正文就绪和完整后台结束是三个不同完成点。

## 3. 模块地图

| 路径 | 责任 |
| --- | --- |
| `src/stage/engine.ts` | 输入、模式、排队、来源守卫、作者保存、共享结算与恢复 |
| `src/stage/agent-turn.ts` / `agent-director.ts` | 普通文本作者、固定阶段、专家报告及实际来源校验 |
| `src/stage/agent-presentation.ts` | 原交付显示绑定，保留历史布局收据读取兼容 |
| `src/stage/materials.ts` / `assemble.ts` | 原始资料、预设、分支历史、摘要与记忆装配 |
| `src/stage/literary-director.ts` | 直出文学导演的完整职责 |
| `src/stage/literary-world-*.ts` / `literary-ecology.ts` | 世界事实/提案/审计和人物、场所生态 |
| `src/stage/npc-parallel.ts` / `npc-ecology.ts` | 原 NPC 候选在同一生态链中接入、验证和采纳 |
| `src/stage/veridis-rewrite.ts` | 独立显示投影的来源、目标补集与原格式保护 |
| `server/database-plugin-*.ts` | 原数据库私有缓存、宿主、模型通道与来源持久化 |
| `server/tavern-plugin-*.ts` / `server/mvu-*.ts` | 原插件及 MVU 的受限运行、管理与派生状态 |
| `server/npc-parallel-*.ts` / `veridis-rewrite-*.ts` | 原来源管理、受限浏览器/Worker、版本和额度 |
| `server/plugin-git-network.ts` | NPC/Veridis 专属 Git 路由；不改聊天模型网络 |
| `src/memory/` / `src/stage/compact.ts` | 原数据库关闭时的旧记忆回退 |
| `src/outline/` / `server/outline-chat-stream.ts` / `web/src/planning/` | 导演室 SSE、分支独立对谈、大纲、研究与长文消化 |
| `src/novel-play/` | 原著绑定、确认开场与既有正文引擎复用 |
| `src/research/` / `src/tools/*research*.ts` | 作者只读证据、授权、缓存、预算与外发检查 |
| `server/web-research*.ts` / `web-source-reader.ts` | 安全公网搜索、原文读取与研究专属传输 |
| `src/tools/` / `.liyuan/extensions/roleplay.ts` | 领域工具与能力投影；扩展中旧 SDK 接线不是第三 Web 模式 |
| `src/stage/request-journal.ts` / `server/request-inspector.ts` | 私有实发载荷与 usage 记录、作用域只读查询 |
| `skills/` / `.liyuan-stage-skills/` | 内置执行协议 / 私人覆盖，二者不能相互覆盖 |
| `web/src/` / `web/public/` / `packages/` | 界面、宿主静态适配与本地 SDK fork |

## 4. 关键边界

### 资料与格式

原始预设决定写法，卡与启用世界书决定格式需求，系统 Skill 只规定职责和执行协议。内嵌世界书自动随卡加载；独立挂载和按卡补充分开。管理写操作携带 `source/cardIdentity/entryKey`，保护 PNG/JSON 及未知字段，不自动开启关闭模块。

主作者一次交付正文与格式，完整 `rpAuthorDraft` 先显示，不被短事实投影替换。不再拍后调用格式识别、生成或补齐模型，也不设作者交付格式门槛。历史格式 pending 只重新绑定原稿，不重复领域结算。

显示正则隔离完整脚手架/`rule_check` 与正文。检查块只能由其完整覆盖规则交付一次，捕获文本转义为原 HTML；字面 `inner/content` 示例不能打开故事作用域。嵌套保护片段按父到子还原，不靠删除占位符掩盖丢稿。行动项保留严格 `<options>` 范围，到 React 才转按钮；这些处理不回写原稿和事实。

Veridis 是显式启用的显示层例外：仅润色精确绑定、规则命中的局部正文，保护原格式与目标补集；有效 complete 投影才可显示。失败、无匹配、取消或过期仍显示原稿。投影不进入任何事实、账本、变量、MVU、数据库或记忆输入；结构保持不证明语义完全不变。

### 酒馆插件与开场前端

宿主加载固定原文件并限制 API 支持面。辅助模型只能产生候选；回合 signal/nonce、来源、revision/CAS、持久额度和进程身份锁拒绝迟到或过期请求。开场脚本只能绑定切换第 0 楼已有 swipe，不能编辑故事；短 body 加载器保留闭合/长度保护和原依赖。

原字节不改并不意味着设置页面不适配。宿主提供中文、主题、`inline-drawer` 及特定助手 fieldset 的折叠；原 Vue 内层不再加第二套点击切换。不得翻译故事/用户代码或改控件值，ESM 可变引用保留，namespace/frozen 不深写。详情见 [TAVERN-PLUGINS](TAVERN-PLUGINS.md)。

MVU 经原助手脚本运行器加载，资产/依赖 hash 不改；变量是派生扩展，不写正文。管理概览仅投影来源、收据和根数量，不证明全部酒馆能力等价，见 [MVU](MVU.md)。

### 原NPC／Veridis来源与兼容范围

两者采用固定上游、私有缓存及独立受管岗位，不扩充 helper/template 安装枚举。来源和自动更新默认关闭。候选下载、合成兼容验收、空闲激活及回退分别管理；激活仍需有效管理租约和 CAS。坏 commit 历史保留，symlink/越界拒绝，不改原文件来绕过失败。

NPC 只在生态路内部生成与采纳，不第二次推进人物；Veridis 核心由独立受限 Worker 执行原模块，不复制提示词或算法。原工作台的规则导入、编辑、导出与保存不代表危险模型/历史/数据库旁路开放。Veridis 原源码与资产受上游再分发限制，不进公开仓库/dist/发行包。见 [NPC](NPC-PARALLEL.md)、[Veridis](VERIDIS-REWRITE.md)。

### 记忆

原数据库使用未改写的上游打包安装文件，宿主 API/事件、配置迁移及世界书激活/深度投送由梨园兼容实现；安装 hash 一致不能证明所有执行语义等价。拍前沿用原插件召回与拦截器输入写回，按原 position/depth/role 投送世界书，不自行读取禁用索引、截断条目或前置改写记忆。

拍后只处理已提交规范正文，持久化带 scope/source/revision，失败留 pending。插件启用后停止旧自动剧情双写、事件提取与旧压缩；旧 SQLite 保留，关闭插件时使用旧路径。正文、账本和原记忆不能为测试成功而重生成。见 [DATABASE-PLUGIN](DATABASE-PLUGIN.md)、[旧记忆](PLAN-RP-MEMORY.md)。

### 正文先交付、后台结算

完整原稿、绑定交付和 pending flush 后触发 `onAuthorReady`；`onTurnEnd` / `performTurn` Promise 仍表示含后台的完整结束。`isSettling` 与 WS settling 明确区分两者，刷新读取完整原稿而不是恢复生成壳。

后台六路是场记、世界、鲜活世界、原数据库、酒馆插件/MVU 与 Veridis，按启用和条件运行。共用冻结规范正文及拍前快照，用 `allSettled` 等待已启动任务退出，来源检查后串行写共享树。数据库/MVU 不等显示投影；owner 资料写操作是其必要前置例外。共享写锁保留到后台结束；新输入只排队，出队后必要恢复通过并持久化前不ACK。`timeToAuthorReadyMs` 与 `totalMs` 分开观测。

后台完成只向匹配 `entryId/entryScope` 发 `liyuan:turn-state-refreshed` 供派生卷宗只读重查，不通过通用 plugins-changed 重跑卡脚本。完整合同见 [执行流程](PLAN-ROUND-FLOW.md#前台交付与后台完成)。

### 权限、取消和恢复

Web剧情的ACK仅在必要上一拍恢复通过且新user持久化后发送，只表示输入已保存。恢复失败则拒绝新输入、不向 Session Tree 落新user并保留客户端草稿；现代deliveryProtocol重放沿用同一入口，旧SDK不承诺可靠ACK。切会话、卡或真实分支使旧结果失效，设置元数据不伪装切支。已保存完整稿的后台失败/取消不标半稿、不退回旧 Roll；缺失领域按收据恢复，已完成领域不重复。故事中的付款、删除或发帖不是现实操作授权；工具/MCP 风险权限仍独立有效。

### 导演室创作对谈

独立对谈按 `discussionId` 与分支隔离，兼容无 id 的旧记录；初次读最近 80 轮、更早分页，模型只参考本对谈最近 8 轮完整问答及有界最近方案，问答总预算 24,000 字符。删除/清空追加分支标记，不物理擦原会话，也不删正文、大纲或提案。SSE 的已保存 `done` 才表示完成；正文生成/结算时拒绝对谈写操作，避免插入共享树。见 [DIRECTOR-ROOM](DIRECTOR-ROOM.md)。

### Agentic Research

生产复用 `runAgentTurn` 的作者工具循环；直出不必经另一个研究模型，导演固定 3/2/2 不变。证据记录区分事实、推断、未解与来源，不直接采纳世界事实；参考 `agentic-loop.ts` 只是协议 oracle。

本地原著与事件证据优先，未来规划不代表角色知情。会话/卡/版本/兄弟分支变化不能复用过期证据。外网为参考，隐私、授权、SSRF、地址 pinning、TLS、取消和预算不降级，研究专属网络不改模型 Key、岗位或全局代理。见 [AGENTIC-RESEARCH](AGENTIC-RESEARCH.md)。

### 模型

按岗位解析连接，保留启用渠道、默认模型、未知兼容字段与其它岗位。Gemini 3.7/3.8 Flash 不统一替换为 Luna；Luna 旧名仅迁移为原生 `gpt-6-luna`，连接仍需实际端点验证。`npcParallel/veridisRewrite` 独立配置，无岗位不借用主演或通用恢复。嵌入另有配置，工具拒绝与网络错误分开报告。

## 5. 验证与维护

[TESTING](../TESTING.md)以 manifest 的实际脚本为准，区分离线、浏览器、原 fixture、真实模型和发行门禁。`verify` 已含后端 typecheck，但不重编 SDK fork、不验证全部插件或实际三平台包。

按用户授权，维护/部署默认不新建手工本地备份或归档；先核验 GitHub 恢复仓库、精确 commit 与匹配产物来源、校验和及可获取性。GitHub 仅覆盖已推送、核验且获准公开的内容，不覆盖 dirty、未推送提交或私有资料；受影响内容不能安全保留/恢复时停止并请求专项方案。已有备份、原子 `.bak` 和更新器内部回退保留，旧更新脚本仍归档，不视为已符合新流程。

候选构建先放临时目录，完成离线/浏览器验证，确认服务空闲与恢复来源有效后才部署；部署后独立核对 health、hello、bundle 与 SW。不 reset 继承 dirty、不自动 commit/push/Release/部署、不放宽私有权限、不偷偷启用旧渠道，不回滚故事或数据库来回退代码。同步与部署分别授权，见[发布流程](BRANCH-RELEASE-WORKFLOW.md)。
