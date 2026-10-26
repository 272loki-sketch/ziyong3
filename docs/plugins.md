# 原插件宿主

"原插件"指上游酒馆（SillyTavern）插件的原文件。梨园按固定来源下载、原字节运行，只写宿主适配（导入、DOM、事件、变量、生命周期、网络）。原插件不写正文、不新增模式；用户在主界面"插件中心"统一管理。原数据库插件见 [memory](memory.md#原数据库插件)；众生侧写是内置模块，见 [world-ecology](world-ecology.md#众生侧写)。

## 通用机制

- **来源固定**：每个来源固定仓库、完整 commit 和逐文件 hash，读取时再核对一次，HTTP 发出的就是刚核对过的字节。篡改、越界、symlink 一律拒绝。
- **私有存放**：原文件与运行状态只放各自的私有目录（0700/0600），不进 Git 和发行包。
- **更新四步**：下载、暂存、合成会话验收、空闲时激活，各自独立。激活需要新的验收和原子 CAS，失败或宿主忙时保留当前版本；保留上一版供回退，回退过的坏 commit 自动更新不会再跳回。上游出现未适配的 API 时拒绝该候选，补宿主而不是改原件。
- **只写派生数据**：插件不回写 `rpNarrative`/`rpAuthorDraft`/thinking，不改原卡；后台失败留 pending，按收据恢复。管理写入只认当前来源，按开始时的 revision 做 CAS。
- **回合身份**：每个回合有固定 nonce 和取消 signal，迟到或旧页面的请求不能借用新回合身份。状态与计数共用进程身份锁（`server/tavern-plugin-lock.ts`）。
- **凭据**：status 返回前递归去掉凭据；插件里填的 Key 和自定义端点不作为传输通道，插件岗位必须显式配置（见 [models](models.md#岗位)）。
- **Git 路由**：助手/模板共用 Git 代理设置；Veridis 走自己的路由，空串表示直连（`server/plugin-git-network.ts`）。
- **许可**各自遵守，不能用梨园许可替代（MVU 混有 MIT 与 PolyForm Noncommercial；Veridis 禁止二传）。

## 默认开关

| 插件 | 执行默认 | 自动更新默认 | 私有目录 |
| --- | --- | --- | --- |
| 原数据库 | 关 | 无（手动下载候选） | `.liyuan-database-plugin/` |
| 酒馆助手 / 提示词模板 | 关 | 开（只检查，不顺带启用） | `.liyuan-tavern-plugins/` |
| MVU | 关（依赖已启用的助手） | 无（脚本安装固定资产） | `.liyuan-tavern-plugins/mvu/` |
| 众生侧写（内置） | 关 | 无 | `.liyuan-npc-parallel/` |
| Veridis Rewrite | 关 | 关 | `.liyuan-veridis-rewrite/` |

安装后不自动启用。`web/src/plugins/registry.ts` 只登记展示信息，不授予权限。

## 插件中心

- **状态概览**：首次打开只显示目录，点"读取全部状态"才查询各模块。概览是带时间的只读快照，区分未安装、已关闭、依赖未就绪、读取失败；某个接口失败不推断其它模块。读取状态不安装、不启用、不请求模型。"本拍任务进行中"表示宿主忙，不代表该插件正在执行；本拍结果看详情里的收据。
- **未保存编辑**：众生侧写设置与 Veridis JSON 有离开保护（切模块、返回目录、关面板、离开页面），取消离开保留编辑。Veridis 保存期间锁定编辑。切换来源后的旧草稿只能复制或放弃，不能写入新来源。读取失败或写入结果不确定时先重读再允许写。
- **原数据库管理台**：临时绑定查询失败时保留 iframe 和编辑内容并暂停编辑，重新核验后恢复；确认会话/卡/分支已变时仍切走旧 iframe，来源隔离优先。

## 酒馆助手与提示词模板

模板/助手在发送前处理事件，交付后由原 iframe 显示卡前端。只启用模板时执行真实 EJS，不伪造 TavernHelper。

- **设置页适配**只做四件事：中文 i18n、主题变量、`inline-drawer` 接线、给缺折叠的 `.TH-fieldset` 补折叠。不克隆、不替换输入节点，不改控件值。
- 可变的 ESM 导出保留引用身份；同步开场 API 只能切换第 0 楼已有的 swipe。
- 脚本发起的模型调用只返回候选，不落正文；主作者忙时拒绝。
- 前端命令只支持 `/setinput`、`/send`、`/trigger`，走正常输入框提交链路；回执只代表输入进入了投递链路。
- `web/public/tavern-compat/` 由运行中的服务动态读取，改文件直接影响线上；它和 HTML/dist、服务端资源白名单、消息桥必须一起切换，不手改上游 bundle。
- 启用脚本就等于信任它：管理和脚本 iframe 是同源受信会话，不是沙箱。
- 正文显示后，已打开的卡帧只接收匹配消息 id 的"已保存"通知，经原 MVU 回调刷新，不重跑脚本。

## MVU

- **加载**：由原助手的脚本树和 iframe 运行器加载，只开卡明确启用的依赖。
- **变量是派生数据**：新楼层继承祖先链上最近的有效变量，不读兄弟分支；没有先前数据时才由原 schema 初始化。
- **时序**：拍后 MVU 和其它领域并发，但等本拍附属补交退出后才解析；要求里有作者漏交的变量更新而补交未完成时留 pending（见 [architecture 附属补交](architecture.md#附属补交)）。
- **解析输入** = 作者原稿 + 已通过校验的补交条目里含闭合 `<UpdateVariable>` 的部分（`mvuParseSource`，`web/public/tavern-compat/mvu-adapter.js`）；其余补交文本只显示。执行条目绑定那份已验证收据的 hash。解析投影可以补上缺失的 `</JSONPatch>`（前提是 JSON 数组完整），原稿不变。
- **额外解析**走 `mvuParse` 岗位：单请求、阻塞、只出候选；工具模式和并行解析不支持，会明确报错。
- **面板**只显示来源、收据、根分组数量和恢复资格，不暴露变量值。单独恢复（`POST /api/mvu/recover`）只重放 MVU 自己的监听器，失败回到基线。

## Veridis 显示润色

- 用户显式启用的可选显示层：投影绑定来源和原稿 hash，存在 `rp-veridis-rewrite`。只有有效的 complete 才替换显示，其余情况一律显示原稿。规则为空或未命中记 skipped，不发请求。
- 投影不回流到事实、上下文、账本、世界/生态、MVU、数据库或记忆，也不承担格式补交。
- 每个任务在独立受限 Worker 里运行原模块，结束即终止；只采用 AI 目标回执，目标以外的字节逐字复制原稿，受保护结构（选项、变量块、HTML、代码、标签）不能被注入。
- 工作台可导入、编辑、导出、保存规则；Deep Clean、历史/数据库净化、反馈网络和模型旁路都禁用。单次重试：`POST /api/turn/retry-veridis`。
- 上游禁止二传：原源码、提示词和资源只在私有缓存里，公开 Git、dist、发行包只含宿主代码。

## 代码位置

| 领域 | 主要文件 |
| --- | --- |
| 助手/模板来源与生命周期 | `server/tavern-plugin-{source,vendor,cdn,imports}.ts` |
| 运行、HTTP、存储、锁 | `server/tavern-plugin-{runtime,http,store,lock}.ts` |
| 宿主前端 | `web/public/tavern-compat/`、`web/src/components/TavernPluginsManager.tsx` |
| MVU | `server/mvu-{assets,view,display}.ts`、`web/src/components/MvuPanel.tsx` |
| Veridis | `server/veridis-rewrite-{source,runtime,http}.ts`、`src/stage/veridis-rewrite.ts` |
| Git 路由 | `server/plugin-git-network.ts` |
