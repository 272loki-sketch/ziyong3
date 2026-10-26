# 记忆

记忆把早先的剧情找回给作者，不是另一套故事事实。有两个后端：旧记忆（默认）和原数据库插件（手动开启）。同一时刻只有一个后端自动写入。

| 后端 | 默认 | 拍前 | 拍后 | 存储 |
| --- | --- | --- | --- | --- |
| 旧记忆 | 是 | 分支摘要；开了向量记忆时召回 | 长局压缩；开了向量记忆时周期入库、提取事件卡 | `rp-summary` + `.liyuan-memory/memory.sqlite` |
| 原数据库插件 | 否 | 原生召回 + 写回本轮输入，合并文学导演 | 原插件填表、生成派生世界书 | `.liyuan-database-plugin/` |

- 开启数据库插件后，旧记忆的自动入库、事件提取、摘要压缩全部停止；旧 SQLite 和已有摘要保留为只读资料，照常装配。关掉插件即回到旧路径。
- 两个后端都只消费已保存的正文，绑定 session、卡、来源和 revision；草稿、thinking、工具回执、半稿不入库。

## 旧记忆

- **长局压缩**（`src/stage/compact.ts`）：早期正文攒够后写 `rp-summary`，装配时作为前情提要，最近若干拍保留原文。手动入口 `/compact`。
- **向量记忆**（`src/memory/`，默认关）：剧情库按周期写入正文片段和事件卡（`剧情记忆摘要` Skill），被压缩的正文归档为证据；额外库放手工资料。拍前召回受 `injectOnTurn` 控制，作者也可用 `memory_search` 主动查。

约束：

- 按 session + 卡分库，读取时按当前祖先链校验来源，兄弟分支不可见。事件 id 由代码生成，事件游标在全部入库后才推进。
- 嵌入分本地哈希与云端两种，独立于作者模型。检索不跨嵌入空间混算；换模型或维度后手动"重建向量"，不自动收费重嵌。
- 检索没命中只是检索缺口，不能写成"事件没发生"或"角色失忆"。

周期、容量、保留拍数见 `src/memory/types.ts`、`src/stage/compact.ts`。

## 原数据库插件

安装产物按固定来源与 hash 私有缓存，原字节执行 UI、填表、检索、召回任务与输入模板。梨园只写宿主：在隔离浏览器（Playwright）里提供 `SillyTavern`/`TavernHelper` 接口与聊天事件，接管模型路由、分支、设置、世界书、私有文件和生命周期。来源与更新规则同其它原插件（见 [plugins](plugins.md#通用机制)）。

- **召回与写回**：用户输入落树后，后端调用原 `TavernHelper.generate` 拦截器，由上游完成召回与模板写回；拦截器交出的 `user_input` 原样给作者。宿主不关闭原召回、不另拼记忆、不改模板。
- **世界书投送**：激活条目按原 `position/depth/order/role` 投送完整原文；未适配的位置或不支持 inline system 的协议直接报错，不擅自改位（`src/stage/database-plugin-prompt.ts`）。
- **书的作用域**：角色内嵌书、卡绑定书和该卡补充书归角色；其它挂载书归全局，可读可手选，默认任务不扫描。每本书保留自己的 uid 空间。
- **合并文学导演**：数据库启用时，文学导演候选并入同一次召回请求产出（原因见 [decisions](decisions.md#7-数据库启用时文学导演并入原生召回)）。宿主在召回请求里附上 Stitches Skill、分支状态、人设、生态和选定大纲，取下候选后把原回复交回上游解析。
- **模型**：`literaryDirector` 是召回/推进的唯一入口，插件的召回模型实时镜像它；拍后 `fillModel` 与嵌入独立。改模型使旧缓存失效，无需重启。
- **剧情开关**：宿主保留用户的 `plotEnabledGlobal` 与预设（唯一例外：召回桥版本升级时置开一次）。原插件的独立续写/推演不启用。
- **事实边界**：插件只写 `TavernDB_*` 消息扩展，不写正文或 thinking；生成的世界书是专用派生书，原卡与挂载书只读；Key 留在服务端。
- **pending**：正文保存时先写 `rp-database-memory: pending`，拍后填表成功记 complete。下一条输入在 ACK 前先补它，补不上就拒收。
- **管理台**：主界面"数据库"弹窗打开原插件完整前端，切卡/会话/分支自动重绑。

请求大小与时限见 `server/database-plugin-{models,generation}.ts`。

## 排障顺序

1. 先确认哪个后端在工作：插件 `enabled`，旧记忆总开关与剧情库开关。
2. 正文在、记忆缺：查 `rp-database-memory` 或旧记忆游标，按收据补。
3. 召回为空：原任务开关、角色绑定书、位置字段、真实模型错误、最终 `user_input`；旧记忆看嵌入空间与 scope。
4. 管理台打不开：源码指纹 → Chromium 依赖 → 宿主加载状态 → 当前绑定。

## 代码位置

| 领域 | 主要文件 |
| --- | --- |
| 旧记忆 / 长局压缩 | `src/memory/`、`src/stage/compact.ts` |
| 插件来源与更新 | `server/database-plugin-{source,update}.ts` |
| 宿主与存储 | `server/database-plugin-{http,runtime,store,models,generation}.ts`、`web/public/database-plugin-host.*` |
| 书与投送 | `server/database-plugin-lorebooks.ts`、`src/stage/database-plugin-prompt.ts` |
| 合并导演 | `src/stage/literary-director.ts` |
