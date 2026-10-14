# 项目结构与隐私边界

仓库按产品源码、验证工具、文档与构建产物分工。运行资料仍使用代码现有路径；本指南不迁移目录，不改变配置发现、会话身份或插件存储协议。目录整理不能以删除用户资料、覆盖 dirty 改动或重写故事为代价。

## 公开目录

| 路径 | 职责与维护原则 |
| --- | --- |
| `src/` | 领域实现：正文引擎、资料装配、世界/生态、记忆、研究、大纲与小说开演 |
| `server/` | 会话宿主、REST/WS/SSE、模型和插件运行适配、安全网络与只读诊断 |
| `web/src/` | React 界面、状态与正文显示 |
| `web/public/` | 宿主 HTML、桥接脚本、样式和 SW；部分文件由服务动态读取，编辑可能影响未重启服务 |
| `web/dist/` | Vite 前端产物；可跟踪便于启动，但必须来自匹配源码，不手工修改 bundle |
| `packages/` | 本地 runtime/API fork；应用使用已编译 SDK，源码修改和 dist 重编须另验 |
| `skills/` | 内置职责与执行协议；不是用户预设，也不覆盖用户私人 Skill |
| `.liyuan/extensions/` | 产品工具及热刷新接线源码；隐藏目录中的唯一明确产品例外 |
| `assets/` | 公共默认素材与本机导入素材可能共存；只有明确允许且可再分发的默认素材可公开 |
| `test/`、`web/test/` | 合成领域、宿主与浏览器测试；原插件 fixture 从仓库外显式提供 |
| `scripts/` | 公共测试、安装、构建与打包工具；目录中的本机诊断/部署脚本不因此成为公开产品文件 |
| `docs/` | 源目录可并存指南与本地记录；公开仅含精确白名单中的长期指南，导航不链接记录或附件 |
| `deploy/`、`.github/` | 示例部署和 CI 配置；不包含真实地址、认证或运维产物 |

根目录保留 manifest、锁文件、启动器、许可、示例配置和入口文档。不要为了视觉简洁搬动运行代码、SDK、静态资源或相对路径依赖。新增文件按职责归入已有目录，避免在根目录不断新增诊断脚本、日志和截图。

### 文档与记录

公开 Markdown 只允许 `README.md`、`TESTING.md`、`AGENTS.md`、`CLAUDE.md`、两份部署指南、`licenses/README.md`，以及[文档导航](DOCUMENTATION-INDEX.md)中的现行主题指南和导航本身；许可原文另按 `licenses/Luker-AGPL-3.0.txt` 精确白名单处理。精确路径白名单由 `scripts/public-repository-policy.mjs` 维护，不允许整个 `docs/` 目录。验收、研究实施报告、审计、历史协议、交接、Release/版本记录及 `PLAN-KNOWLEDGE-ENGINE`、`KNOWLEDGE-RESEARCH-VALIDATION`、`DATABASE-DETACHMENT` 文档不在公开集合内。

本地验收记录不随公开仓库发布。记录和日期留在本地源目录，曾经跟踪不等于批准公开，也不授权删除或重写；日志、Word 文档、文档图片与截图同样不发布。公开指南保留长期职责、兼容限制和未验证范围，但不链接本地记录或附件。导出器须跳过源记录并裁除公开基准树遗留记录，只修改候选树，不改源文件；它不能清除旧远端历史、已有 clone 或旧发行包中的副本。完整审阅与授权边界见[隐私与公开流程](PRIVACY-AND-PUBLISHING.md#公开指南白名单)。

## 现有私有路径

以下是**源码定义的路径类别**，不是对某台机器磁盘内容的审计。位置相对运行项目目录；用户级 Agent 目录、部署挂载与配置选项还可能使数据位于仓库外。

| 路径 | 私有内容 |
| --- | --- |
| `liyuan.agent.json`、`liyuan.agent.meta.json`、`liyuan.config.json`、`liyuan-preset.json` | 实际连接、模型岗位、身份、资料和运行设置；示例文件才可公开 |
| `.liyuan/` | 项目设置、访问控制、资料装配、研究与其它运行元数据；`request-journal/` 可含实发载荷和 usage |
| `~/.liyuan/agent/` | 默认用户级 Agent 数据，包括认证、配置及会话；`LIYUAN_CODING_AGENT_DIR` 可显式指定其它位置，旧 `PI_CODING_AGENT_DIR` 仍有兼容 |
| `.liyuan-stage-skills/`、`.liyuan-skills/` | 用户 Skill 覆盖与用户资料；升级不能替换私人覆盖 |
| `.liyuan-memory/`、`.liyuan-state/`、`.liyuan-worldline/` | 旧记忆、状态缓存与分支相关数据；Session Tree 仍是故事权威 |
| `.liyuan-artifacts/`、`.liyuan-assistant/`、`.liyuan-cache/`、`.liyuan-codex/` | 工件、助手会话及缓存 |
| `.liyuan-lore/`、`.liyuan-media/`、`.liyuan-audio/`、`.liyuan-uploads/` | 用户世界书、媒体与上传资料 |
| `.liyuan-personas.json`、`liyuan-profiles/` | 用户身份与配置档案 |
| `.liyuan-database-plugin/` | 原数据库安装缓存、浏览器依赖、私有设置及派生记忆 |
| `.liyuan-tavern-plugins/` | 原助手/模板、MVU、依赖和分支派生状态 |
| `.liyuan-npc-parallel/`、`.liyuan-veridis-rewrite/` | 原插件私有下载、网络/设置、候选及显示投影 |
| `.liyuan-research/` | 研究专属网络设置；原著文本等研究资料另有 `.liyuan/outline/research/` 路径 |
| `data/`、`.backup/`、`*.bak`、`.env*` | 容器挂载、备份和本机环境；不可打包或暂存 |
| 旧 `.rp-*` / `.pi/` 及旧配置 | 读取/迁移兼容数据，不可因名字过时当作可删除垃圾 |

路径定义主要见 `src/paths.ts`、`src/stage/skill-store.ts` 和各插件 store/source。不要假定所有会话都在项目 `.liyuan/` 下，也不要用文件 mtime 猜最新会话。查记录先读 [READING-THINKING](READING-THINKING.md)，只需状态时不读原文。

## 公共素材

`.gitignore` 使用卡/世界书白名单；发行脚本还有独立的素材裁剪政策，二者不必具有相同允许集合。被 Git 跟踪不等于可随包发布，被忽略也不等于已经脱敏。

公开 fixture 应为自行生成的合成文本，有可验证的来源。不得抽取真实故事、thinking、用户代码、截图或版权卡当回归数据。原插件实测使用仓库外合法 fixture，不自动回落生产缓存。Veridis 原源码、提示词、模板、图片、vendor 和私有缓存不再分发；公开仓库只保留宿主适配。

## 隐私检查

日常公开推荐[一键公开 Git](PRIVACY-AND-PUBLISHING.md#一键公开-git)：

```bash
npm run git:public
# 更新已有公开分支时必须显式提供公开基准：
npm run git:public -- --remote https://github.com/OWNER/REPO.git --branch main
```

默认创建唯一的仓库外、已精确暂存的新仓库，不携带源历史，不配置 remote；已有分支更新则浅取并审计显式公开头，保留公开祖先关系。源工作树字节是导出权威，源索引暂存内容不作为导出内容，源配置/索引/私人资料不改动。政策不允许的私人和未知路径不读内容，只报告跳过数量；用户须核对遗漏和候选完整 diff。候选不含私人配置或运行工件，也不覆盖已有输出。候选的精确自动暂存是专用例外，源仓库仍禁止 blanket add。

仅候选 `.git` 内安装可信 guard 和二进制 hash manifest，提交前检查实际暂存快照，推送前检查全部新增提交；精确批准的二进制改动须人工审阅后显式 `--allow-binary-changes`，任意二进制不放行。准备不提交/推送，人工审阅与独立授权仍不可省略，也不保证所有秘密或版权问题自动识别。

高级源仓库手动流程中，公共候选审计与实际暂存审计是两个不同门禁：

```bash
npm run privacy:check
npm run privacy:staged
npm run test:release
```

`privacy:check` 用于工作树公开候选；`privacy:staged` 用于整个索引中的实际暂存内容，不能拿磁盘最新内容替代已暂存字节；`privacy:commit -- <ref>` 用于指定提交的完整快照。工具与限制见 [隐私与公开流程](PRIVACY-AND-PUBLISHING.md)：命令不存在或执行失败表示门禁未完成，不得以旧检查代替。

已有 `scripts/check-public-data.mjs` 检查跟踪 Markdown 的未泛化个人 home 路径，以及两份 SDK 会话 fixture 的合成来源和生成字节；它不是全仓秘密扫描器。`test:release` 在临时合成目录验证打包路径政策，不生成真实发行包。候选/暂存扫描、历史审查和最终归档检查均需独立执行，结果不保证所有隐私或版权问题自动识别。

扫描不得遍历私有目录或打印命中的凭据/原文来证明自己找到问题。人工审阅以公开候选、合成来源和脱敏发现类别为基础；真实凭据核对只能在另行授权的私有流程中进行。

## 本地运维约定

可以把**新建的仓库内运维输出**规划到私有根 `.local/`，例如合成截图、候选构建和脱敏报告；更稳妥的默认仍是仓库外受限目录或 `/tmp`。这只是未来约定，**不是当前统一数据根，也没有自动路径迁移或运行时配置支持**。采用前须确认 Git、归档和部署政策都排除该目录，不能仅凭名称假定安全。

现有运行资料仍留在上表路径。不得把它们直接搬进 `.local/`、建立绕过来源门禁的软链接，或宣称一次文档整理已完成隐私迁移。未来真正统一数据根，需要显式授权、路径配置、兼容迁移、备份和恢复验证；不属于文档重写。
