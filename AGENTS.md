# 梨园维护约束

## 阅读与范围

- 进入项目先读本文件、`CLAUDE.md`、`docs/DOCUMENTATION-INDEX.md`、`docs/ARCHITECTURE-OVERVIEW.md`、`docs/GENERATION-MODES.md`、`docs/PLAN-ROUND-FLOW.md`；按任务继续读主题指南。导演室另读 `docs/DIRECTOR-ROOM.md`，会话/思考记录先读 `docs/READING-THINKING.md`。
- 用户只要求同步或只读时不改代码；修改、提交、推送、合并、Release 与部署分别授权。不 reset、覆盖、自动 stash 或清理继承 dirty，不擅自 commit/push/Release。
- 版本以 manifest 为准，实际服务、远端同步与公开 Release 分别核验。部署时间、私人配置状态、固定测试数字和失败历史留在独立验收记录，不复制为当前维护合同。

## 作者、资料与事实

- Web 只有 `direct/director`，模式绑定提交输入并随排队、重放和重 Roll 保留；普通文本单主 Agent 写正文。direct 保留正常文学导演，不新增拍前生态、心理画像或团队审稿；director 固定三证据、双角度、双审阅，由主作者决策定稿。专家只报告，同阶段不互看、不接完整作者 thinking；失败报告不称审阅通过。
- 旧 SDK 稿纸及 JSON 解析器仅保留既有读取/调用兼容，不恢复第三种 Web 模式、`ask` 剧情停点、自动画像或逐段门禁。导演室对谈、研究和插件不是额外正文作者。
- 导演室独立对谈按 discussionId/分支隔离并保留旧记录兼容、历史分页；新建不删旧聊天，删除/清空追加标记，不物理擦除会话或正文。
- 原始启用预设决定写法，卡/世界书决定格式；`skills/*/SKILL.md` 负责职责与执行协议。仅在明确授权范围修改内置协议，不偷改原预设、卡或 `.liyuan-stage-skills/` 私人覆盖，升级不替换用户 Skill。
- 正文与卡格式由同一作者一次交付；不设作者格式成功门槛，不拍后调用模型识别、生成或补齐格式，不添加固定面板白名单，不复活关闭素材。真实截断、断流和半稿仍如实标未完成。
- Session Tree / `rpNarrative` 是故事权威；完整 `rpAuthorDraft` 与绑定正文 id 的交付先显示，短事实投影不能替换原稿。布局、摘要、专家报告、候选、工具回执和未提交稿不是故事事实；派生工件绑定 session/card/合法祖先，兄弟分支不可见。
- 内嵌世界书随卡自动加载，不复制挂载；管理写操作带 `source/cardIdentity/entryKey`，保留未知字段，不自动开启关闭模块，不拿生产 PNG 试写。故事行为不等于现实工具/MCP 授权；作者资料/面板写操作延后到正文保存后，取消不执行。

## 先交付与后台恢复

- 输入 flush 后 ACK 只表示已保存。完整原稿、绑定交付及 pending 收据 flush 后立即 `onAuthorReady`，不等世界/生态/数据库填表；director 仍须完成 review/decision/finalize，不将中间稿冒称定稿。
- `onTurnEnd` / `performTurn` Promise 表示含后台的完整结束；`isSettling` 与 WS settling 区分正文就绪和后台整理。共享 Session Tree 写锁保留到后台结束，新输入可发送但只排队，下一拍先恢复缺失领域。
- 场记、世界、鲜活世界、原数据库、酒馆插件/MVU、Veridis 六路按启用条件并发计算，共用冻结规范正文与拍前快照，`allSettled` 等待已启动任务退出；来源/取消/revision/CAS 守卫后串行落树。NPC 只在生态路内生成和采纳，不另开一路双重推进。
- 世界/生态拍前账本只作 reference-only，本拍已保存事实优先，可信正文不截断。数据库/MVU 不等其它领域或 style，也不消费显示投影；依赖作者资料写操作时保留 owner 写入前置例外。
- 切会话/卡/真实分支拒绝迟到结果，设置元数据不伪装切支。完整稿的后台失败/取消不标半稿、不退旧稿；按正文 id 和完成收据恢复缺失领域，不重写故事、不重复已完成事实，旧格式 pending 只重绑原稿。
- 后台 hello 仅向匹配 `entryId/entryScope` 发 `liyuan:turn-state-refreshed` 供卷宗只读重查，不发通用 plugins-changed 重跑卡脚本。作者就绪耗时与整拍耗时分开记录。

## 模型与观测

- 岗位独立配置，保存以当前完整启用配置为基底，保留渠道、默认模型、其它岗位、开关和未知兼容字段；不能用旧配置子集覆盖。Gemini 3.7/3.8 Flash 不全部替换为 Luna；仅 Luna 旧名迁移到原生 `gpt-6-luna`，连接需真实端点验证，嵌入另配。
- 工具能力逐模型保存、默认支持，明确关闭不自动开启；禁用原生工具不偷换 director 模式，不伪装依赖工具的操作已执行。认证、配额、schema 和网络失败不等于不支持工具。
- `stepModels.npcParallel/veridisRewrite/mvuParse` 使用各自受管岗位；缺失/不可用不借用主演、Luna 或通用恢复。保留 Flash 岗位分工，不为验收改私人模型配置；插件 API 控件只投影实际岗位，不复制 Key 或改旧自定义 API 配置。
- 温度经受管通道传递；attempts、真实 provider usage 和墙钟分别记录，缺 usage 不记零或推算总账单。请求查看器只读且受私有目录和来源门禁保护，预览/估算不称实发账单。
- 查记录用真实 id、条目 timestamp 与时区，不用 mtime 猜最新；只需状态时不读原文。

## 原插件与来源

- 数据库、酒馆助手/模板、NPC、Veridis、MVU 的原文件/依赖固定来源及 commit/hash，不 fork、不打补丁、不复制原核心提示词或算法绕过失败；改动落在宿主适配。原字节或结构一致不证明百分之百语义、原生行为或全部酒馆/API 等价。
- 保留回合 signal/nonce、进程身份锁、source/scope、开始 revision/CAS 与每 session/card/source 八次持久辅助额度；失败尝试不退款、重启不清零。NPC 生成/接入/schema 修复共用其额度，Veridis 独立，MVU 使用助手额度，不混同作者预算。
- NPC/Veridis 来源与 autoUpdate 默认关闭，安装/启用/更新分别管理，不扩 helper/template 枚举。下载候选不称兼容通过；暂存激活须合成验收、空闲、有效异步管理租约与 CAS，保留坏 commit 历史和旧版回退，拒绝 symlink/越界。
- 管理严格当前 source，后台恢复才允许合法祖先；私有结果按开始 revisionCAS 写入。status 去凭据，设置保留未知 JSON 与私人 Key；含 Key 数组仅按唯一 id 合并或拒绝不确定重排。私有目录/文件保持 0700/0600，不放宽权限。
- `server/plugin-git-network.ts` 只管 NPC/Veridis Git：明确参数 → 专属 env → 本插件私有 network.json → Tavern 共享 env/文件 → Git 环境回退；Veridis 新 `LIYUAN_VERIDIS_REWRITE_GIT_PROXY` 优先旧名。空串为显式直连，不作 falsy 回退；不改共享网络配置、旧插件或模型 Key/端点/provider，不关闭 TLS 验证。
- `web/public/` 部分桥接/样式由服务动态读取，编辑可影响未重启服务；HTML/dist、资源白名单与服务端接线配套切换，不手工修 bundle。
- 宿主可适配中文、主题、inline-drawer 及有直接 legend 且非 `.TH-collapsible` 的助手 `.TH-fieldset`；原 Vue 折叠不叠第二套 click，不翻译故事/用户代码或改控件值。保留可变 ESM 引用，namespace/frozen 不深写；开场只切第 0 楼已有 swipe，不开放脚本正文编辑，短 body parser 保留闭合/长度保护。
- MVU 通过原助手脚本运行器加载，变量仅派生、不写正文；管理概览只投影来源/收据/根数量，面板反馈不依赖被弹窗遮住的全局 toast，启用不等于该拍已处理。

## 记忆、NPC 与显示润色

- 原数据库拍前沿用原召回、拦截器及模板输入写回，原生剧情任务包含召回，不强制关闭 `plotEnabledGlobal`；世界书按上游 position/depth/role 投送，不自行读禁用索引、前置/改写记忆或截断条目。宿主 API/事件、配置迁移及投送是兼容实现，安装 hash 不能证明原生等价。
- 拍后记忆只消费已保存规范正文，带来源/revision，失败留 pending；插件启用后停止旧自动剧情双写、事件提取与压缩。旧 SQLite 保留回退，周期窗口完整、正文及偏移基准明确，按 session/card/祖先隔离。生产原记忆只读保留，实测用临时库合成故事，不重生成生产故事凑成功。
- NPC 原侧写是候选，绑定正文来源/人物/上游 commit/候选 hash，经同一生态链统一采纳后才成状态，不直接入正文或记忆；历史仅接续合法祖先中已采纳经历，业务 reject 整批丢弃拟议生态，不另造故事补成功。
- `npcManagedOutputBudget` 为独立受管侧写保留 4096 下限，不放宽上限、八次额度或截断拒绝。用户承诺无本拍真实输入/正文锚点属于技术失败，同来源同岗位最多收费修复一次，仍失败保持 pending。
- 旧精确错误 complete 收据按该正文前生态恢复，不能因已有错误来源快照跳过校验；保留已完成其它领域与原稿，恢复只推进该拍应有 round，不重复采纳，历史收据 append-only。
- Veridis 仅显式启用的 source/原稿 hash 绑定局部显示投影，独立受限 Worker 执行原模块，保护原格式与目标补集；空规则/无命中明确 skipped，仅有效 complete 可显示，失败/取消/过期仍显示原稿。投影不回写原稿、事实、变量、MVU、数据库或记忆，不成为新作者或格式补交模型。
- Veridis 原工作台用私有原 shell/events/rules/presets/模板；允许规则导入、编辑、导出、保存，JSON 错误可修正重存。Deep Clean、历史/数据库净化、反馈网络和模型旁路禁用；保留原资产 GET 白名单、无 Key 上下文、settings CAS 与空闲门禁。上游再分发限制独立遵守，原源码/提示词/styles/templates/images/vendor 仅私有下载缓存，不入公开 Git/dist/发行包。

## 显示隔离与验收

- 完整脚手架/`rule_check` 与正文是独立正则作用域；检查中的字面 inner/content 示例不能打开故事标签。检查仅接受自己的完整覆盖规则一次，捕获文本转义进入原 HTML，不再跑内联对白/心声规则，不生成嵌套整页 HTML；普通正文/BBS 后续规则不受此例外影响。
- 原卡规则可渲染原检查折叠面板；无 renderer 则进思维折叠，不当正文，不增作者格式门槛或模型检查。`applyCardSkinProtected` 支持已隔离片段，按父到子、索引降序还原，不靠删除 PUA/占位符掩盖丢稿，不改用户原卡/模板。
- 作者正则优先后的显示策略保留严格 `<options>` 范围，到 React 才转按钮，未知标签不能先 unwrap 成裸选项再叠按钮；显示处理不回写原稿、事实、上下文或旧存档。
- 显示验收必须桌面/手机实际展开与收起原面板，核对 DOM 完整文本、字面标签、围栏与源码尾巴；折叠壳正确或 pageErrors=0 不够。静态预览、合成回归及结构保护不证明所有卡脚本或文学质量通过。

## 隐私、验证与发布

- 公开 Markdown 仅限明确批准的长期介绍、使用与开发指南，按文档导航及精确路径白名单审阅；验收、实施/研究报告、审计、历史协议、交接、版本记录、Word 文档、文档图片、日志和截图不导出、不上传。公开指南不链接这些本地资料，必要限制保留并注明“本地验收记录不随公开仓库发布”。记录即使已跟踪仍在源目录原样保留；导出器裁除公开基准树遗留记录不等于清除旧远端历史，不授权改写历史或删除源记录。

- 按 `docs/PROJECT-STRUCTURE.md`、`docs/PRIVACY-AND-PUBLISHING.md` 和 `docs/BRANCH-RELEASE-WORKFLOW.md` 操作。私人配置、Key/OAuth/SSH、会话/thinking、用户 Skill/素材/代码、截图、插件缓存和备份不进公开候选；fixture 必须合成且来源/许可可核验，不抽取生产资料。忽略不等于脱敏、可删除或获准公开，不迁移私有路径来整理目录。
- `npm run privacy:check` 检查工作树公开候选；明确授权提交后只精确暂存预期路径，审阅完整 `git diff --cached` 并运行 `npm run privacy:staged` 检查实际索引字节，每次索引变化重跑。禁用 blanket add 和强加私有文件。
- 明确授权推送前，对每个拟公开提交运行 `npm run privacy:commit -- <ref>`，审阅全部 outgoing commits 与 base diff，不只检查 HEAD。另运行 `node scripts/check-public-data.mjs` 核对其有限覆盖；命令缺失/失败就是门禁未完成。扫描不遍历私有目录、不打印命中原文/凭据，也不替代全历史、版权、人工审阅或最终归档检查。
- 测试使用 Node 22.19.0 或满足 manifest 更高下限的版本；按 `TESTING.md` 选择 `verify`、浏览器、临时构建和专项，SDK fork 重编另验。分别报告基线、fixture、pass/fail/skip、真实模型和未覆盖范围；保留失败/超时/未知 usage，不用固定总数或单次探针宣称全部通过。
- 修改引擎须说明单作者、固定 3/2/2、原稿先行、冻结输入、串行落树与恢复不重复；合成回归覆盖两模式、慢后台、排队、半稿、取消、切支、重 Roll 和缺失收据。原插件/真实模型/生产只读核对另行授权。
- 打包只在无运行数据的干净公开 checkout，运行隐私门禁与 `test:release`，再用维护中的 packer 并独立审阅归档。旧 `pack-for-linux.ps1` 已禁用；合成打包测试不证明真实三平台包安全或可启动。
- 按用户授权，维护/部署默认不新建手工本地备份或归档；先核验 GitHub 恢复仓库、精确 commit 与匹配产物及校验和。GitHub 只覆盖已推送、核验且获准公开的内容，不覆盖未推送提交、dirty 或私有资料；受影响内容无法安全保留/恢复时停止并请求专项方案，不自动备份、推送或部署。已有备份不删除，原子写入 `.bak` 与更新器回退不禁用；旧更新脚本仍归档，不视为已符合新流程。
- 部署另行授权：临时候选 build、离线/浏览器验证、确认空闲和恢复来源有效后才切换；核验 health/hello/bundle/SW 与私有磁盘保护。不默默启用插件/autoUpdate/旧渠道、不改私人连接、不回滚故事或数据库来回退代码。
