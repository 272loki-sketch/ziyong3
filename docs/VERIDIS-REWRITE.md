# 原 Veridis Rewrite：来源绑定的显示润色

Veridis 是用户显式启用的可选显示层：完整作者交付后，由独立受管岗位对规则命中的正文做局部润色。它不是第三种正文模式，不改变 direct/director、单主 Agent 或导演固定 3/2/2 分工。本文说明宿主合同，不描述任何机器的安装、启用、模型配置或部署状态。本地验收记录不随公开仓库发布。

## 原稿与显示投影

| 工件 | 权威与用途 |
| --- | --- |
| `rpNarrative` | 已提交故事事实，保持原样 |
| `rpAuthorDraft` 与绑定原交付 | 主作者完整原稿及原格式，先行显示与恢复 |
| `rp-veridis-rewrite` | source/原稿 hash 绑定的可选显示稿与收据，不是故事或变量事实 |

`onAuthorReady` 在原交付保存后立即显示原稿，不等待润色。只有来源匹配且有效 complete 的投影可用于对应消息显示；失败、取消、过期、没有可改写范围或规则未命中时保留原稿，不撤回作者成功交付。

显示稿不得回流到后续作者事实上下文、场记、世界/生态、变量、MVU、数据库或记忆。这些领域继续读取冻结规范正文及各自真实材料。润色不是格式识别、格式生成或补齐模型，也不是第二作者重新提交正文。

## 原引擎与隔离

固定上游为 [The-Veridis-Lion/Veridis-Rewrite](https://github.com/The-Veridis-Lion/Veridis-Rewrite)。来源管理以完整 commit、逐文件 Git blob/SHA-256 和整体文件集 hash 固定候选；安装与更新状态须另行核验，不能把指南当成已安装证明。

原文件不修改、不重编。每任务独立 Node Worker 动态导入私有缓存中的原 `appContext`、defaults 与 `aiRewrite` 公开模块，使用原任务检查、matching、planning、generation、response、apply 流程处理原稿副本。原全局提示词从上游 defaults 加载，宿主不复制原提示词、匹配或净化算法来绕过失败。

`TavernHelper.generateRaw` 桥接为受管 callback；原 JSON target 协议、匹配与局部组合由上游负责。插件用户 Key/自定义端点不作为外发 transport。Worker 无私有环境，只可读取验证后的资产根目录，不授予文件写入、子进程、addon 或嵌套 Worker 权限。任务结束即终止 Worker，避免模块单例跨分支复用。

Worker 提供运行隔离和能力限制，不证明任意恶意第三方源码都可安全执行；固定来源、完整性检查和合成验收仍是必要门禁。

## 目标与格式保护

宿主只允许原引擎目标落在原稿中可精确确认的规范正文范围，不猜测或归一化偏移。无法确认范围则明确 skipped，不发起收费生成。

行动选项、MVU/变量块、HTML、注释、代码、标签、链接及相关结构受保护。目标补集逐字节保持，替换不能注入新结构，引号和 Markdown 结构也须保持。保护识别 Unicode 标签、同名嵌套与未闭合块；注释和代码先作为不透明范围，避免把字面示例当真实标签。已识别的完整变量块由原引擎从 AI 请求上下文移除。

宿主使用原引擎解析并接受的 AI 目标回执，核对 ID、原文、UTF-16 起止、规范正文许可范围与结构保护，再按原始偏移投影到原稿副本。原 Program 的整稿输出不作为采纳依据，包括目标内的额外变化；目标外字节直接复制原稿，不靠重复文本锚点猜定位。此适配不复制原 matching、planning、提示词或 response 算法，不新增模型调用。

收据与只读状态中的 `projectionMode` 区分 `native`（投影恰好等于原引擎输出）和 `ai-targets-only`（只采用 AI 目标，丢弃不同的 Program 整稿输出）。后者不承诺完整原插件执行效果等价。错误或缺失目标、重复 ID、范围重叠、结构注入及过期来源均拒绝；Program-only/fallback 不冒充成功 AI 润色。

这些检查只约束可选显示候选，不给原作者设置格式验收门槛或要求补交。结构保持不证明文意、人设、语气或事实语义完全不变，也不保证消除全部文学套话；用户应对照原稿评估。

## 工作台与规则

“酒馆插件”窗口提供独立来源管理与“打开原版工作台/上传规则”。工作台加载私有原 `ui/shell`、events、规则、预设模块及模板，不复制上游 UI 或规则引擎。支持规则集新建、编辑、开关、JSON 导入、切换、导出、保存与重开；高级宿主规则 JSON 入口保留，JSON 错误可修正重存。

工作台是管理页接入，不是完整酒馆生命周期兼容。Deep Clean、历史改写、数据库净化、反馈网络、输入框生成及自定义 API 旁路禁用。API 面板只投影独立 `stepModels.veridisRewrite`，不提供 Key、不复制凭据、不随正文切换模型。原私有字段和未知设置保留；原资产仅允许来源校验后的 GET。上传规则不能扩大模型或故事写权限。

宿主提供有限且可禁用、修改的初始规则，由 `defaultVeridisHostSettings()` 初始化；它们不修改主作者预设、卡或私人 Skill，不构成全面文风质量承诺。规则为空、禁用或无命中时明确 skipped，不生成、不假报成功。原全局提示词和自定义模板继续遵守原设置合同。

### 全局预设与单次重试

私有 `.liyuan-veridis-rewrite/global-presets.json` 支持 `version`、`presets` 与可选 `defaultPreset`。工作台合并全局库，同名会话预设优先。用户显式设置全局默认后，无来源设置或未选中预设且规则为空的分支，在工作台与后台执行中使用该默认；已有自定义规则和原启停状态不覆盖，`useGlobalDefaultPreset=false` 可关闭继承。普通工作台保存只写当前来源，不回写全局库。这是存储与继承协议，不声明存在任何私人命名预设。

来源绑定的 `POST /api/turn/retry-veridis` 只补跑最新完整作者交付的显示润色，要求 `expectedSessionId` 与 `expectedSourceEntryId`；不恢复其它结算、不重写正文。

### 操作与来源守卫

1. 配置独立 `stepModels.veridisRewrite` 岗位。
2. 安装并激活通过合成验收的固定来源；安装不自动启用。
3. 显式启用外层插件，核对原 `enabled/autoTriggerEnabled` 内层开关。
4. 在工作台导入或编辑规则，不填入 API Key。
5. 按来源读取 complete/skipped/failed 与真实请求尝试数，不把 changed 当作语义验证通过。

管理写操作绑定当前 session/card/source、开始 revision 与上游 commit，在读 body 后及异步激活时重查来源和空闲租约。保存采用开始 revision 的 CAS，不能用结束时的新 revision 覆盖并发修改。status 递归去凭据，私有凭据单独保留；含隐藏凭据的数组按唯一稳定 ID 合并，无法确认归属的结构变更拒绝。

缓存同时校验原稿 hash、规范正文 hash、上游 commit 和有效设置指纹；新结果与缓存结果一致投影跳过原因。显示恢复必须匹配正文来源和原稿 hash，兄弟分支或旧原稿结果不可复用。

## 模型与用量

使用独立受管岗位，缺配置或不可用时明确失败，不借用主演、Luna 或通用恢复模型。模型选择由用户配置，不能从指南推定实际岗位。允许的 temperature 经受管通道传递，token 上限与取消由宿主控制。

每 session/card/source 最多 8 次持久受管请求额度，独立于 NPC、助手/模板/MVU 与作者预算；runtime 另有单任务上限。失败或取消后的已预约尝试不退款，重启不清零。尝试次数不等于 provider token 账单，缺 usage 不估算为精确账单。

## 来源、更新与版权

`.liyuan-veridis-rewrite/` 是私有缓存类别，POSIX 目录 0700、文件 0600，拒绝 symlink 与越界资源。受控树包括原 `src`、`styles`、`templates`、`images`、所需 `vendor` 与入口文件；原 README 许可说明随缓存保留，不虚构缺失的 LICENSE 文件。

下载或 hash 一致不等于运行兼容。候选激活须通过合成验收、原字节复核、空闲检查、有效异步管理租约与原子 CAS；可激活已暂存候选，不必重新取 HEAD。失败保留旧版、回退来源与坏 commit 历史。执行和 autoUpdate 默认关闭；显式启用自动更新后按服务检查周期运行。未知 manifest 元数据保留，危险原型键、执行与资产声明严格校验，未知 API 不绕过门禁。

CLI 只暂存候选：

```bash
node scripts/install-veridis-rewrite.mjs --cwd /path/to/liyuan --commit <完整40位commit>
# 如需代理，显式追加 --proxy <无凭据HTTP或HTTPS代理地址>
```

`server/plugin-git-network.ts` 的 Git 路由优先级为：明确参数 → 插件专属环境变量 → 本插件私有 `network.json` → `LIYUAN_TAVERN_GIT_PROXY` → 共享 tavern `network.json` → Git HTTP(S) 环境代理。Veridis 优先 `LIYUAN_VERIDIS_REWRITE_GIT_PROXY`，兼容旧 `LIYUAN_VERIDIS_GIT_PROXY`；NPC 使用 `LIYUAN_NPC_PARALLEL_GIT_PROXY`。

`gitProxy: ""` 表示显式直连，不回退共享或环境代理；字段缺省才回退。专属网络文件保持私有权限，拒绝 symlink、非法类型、非 HTTP(S) 或含凭据代理。此适配不修改共享网络配置、旧插件或聊天模型 Key/端点/provider，不硬编码机器网关、不关闭 TLS 验证。

上游 README 对商业使用、原版本体二传与传播方式有限制。接入采用用户从原仓库下载、私有缓存运行；公开 Git、dist 与发行包仅包含宿主适配，不镜像、打包或复制原源码、提示词、styles、templates、images、vendor 或私有缓存。私有下载不等于获得再分发或商业使用许可，须遵守上游当前许可说明。

验证方法与未覆盖范围见 [TESTING](../TESTING.md#众生侧写与veridis)。原字节一致、结构保护和单次合成模型成功均不证明完整酒馆等价或文学质量通过。
