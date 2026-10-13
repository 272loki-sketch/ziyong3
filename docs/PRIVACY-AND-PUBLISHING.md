# 隐私与公开流程

[项目结构](PROJECT-STRUCTURE.md)定义公开源码与私有运行路径。本指南规定与这些边界一致的公开门禁，不搬动数据、不改变配置发现、不迁移运行存储；现有私有资料仍留在原路径。

## 一键公开 Git

推荐用 `npm run git:public` 一次生成筛选后的、已暂存的公开 Git 候选，不必先在含私人运行资料的源仓库整理索引。要求 Node.js 22.19.0 或更新版本，并满足 manifest 的更高下限。命令只准备候选，不提交、不推送、不部署；准备命令不等于授权后续公开。

首次建立公开仓库，在源仓库根目录执行：

```bash
npm run git:public
```

成功时输出 `pass`、唯一的仓库外候选路径和文件/跳过数量。默认在系统临时目录创建全新目录（Linux 存在 `/tmp/opencode` 时优先使用），不覆盖旧输出。候选是**没有源历史的新仓库**，默认分支为 `main`，公开文件已精确自动暂存，没有配置 remote。它适合首次公开，**不适合覆盖已有公开分支**；不要用强制推送解决无共同祖先的问题。

更新已有公开分支时，必须改用显式公开 HTTPS URL 和目标分支：

```bash
npm run git:public -- --remote https://github.com/OWNER/REPO.git --branch main
```

脚本只浅取该公开分支的头（`--depth=1`，不取标签或子模块），审计其快照后以它为候选 `HEAD`，暂存当前公开工作树相对该基准的完整增删改。后续提交保留公开祖先关系，不带入源仓库历史。源快照没有的公开基准文件会暂存删除，务必检查 diff 和 `baseRemovals`。脚本不使用源仓库已保存的 remote，也不在候选配置 remote；不能用默认新历史模式代替已有分支更新。远端基准不合政策、分支不存在或获取失败时停止，不把失败目录当成可发布候选。浅候选不证明远端全部历史已审计。

在成功输出的候选目录打开终端，先审阅，再由用户明确选择提交。以下提交消息仅为示例，实际内容由用户决定：

```bash
git diff --cached --stat
git diff --cached
git commit -m "Prepare public snapshot"
```

统计不能替代完整 diff。候选的精确自动暂存是经过政策筛选后的专用流程，不是允许对源仓库整体 `git add .` 或 `git add -A`。确认遗漏文件和全部拟公开提交后，只有获得**单独推送授权**才执行下列命令；首次公开还须确认目标为空或目标分支不存在。URL 中不得放 Token、密码或其它凭据，认证只走另行授权的私有凭据管道，不写入仓库配置或日志：

```bash
git push https://github.com/OWNER/REPO.git HEAD:main
```

替换 `OWNER/REPO`，并让推送目标与准备时的分支一致；这里不保存 remote。不要 force-push，不用 `-n` / `--no-verify` 或禁用 hooks 绕过检查。若远端头已变化或 hook 因缺端点/浅历史拒绝，应重新按显式远端模式准备并审阅，不强推、不让 hook 自动联网补历史。

### 筛选与审阅边界

- 源工作树的当前字节是内容权威，不使用源索引中的暂存 blob 作为导出内容；索引仅用于路径、跟踪状态、模式和冲突检测。包含允许的未忽略新文件，已跟踪文件在磁盘缺失则按删除处理。源工作树、索引、配置、历史与私人资料保持不变，不在源仓库安装 hooks。
- `scripts/public-repository-policy.mjs` 是批准路径政策，不是“所有非忽略文件都公开”。私人路径和未知/未批准路径先按类别计入 `skipped`，不读取其内容、不遍历私有目录；即使未知文件未被忽略也会省略。用户必须核对跳过数量、候选文件集和遗漏，确需新增公开文件时先审查来源/许可并精确更新政策，不能把 `pass` 当作产品文件必然齐全。
- 允许路径中的已知凭据、私钥、带认证 URL 等内容命中会阻断，而不是静默删改、替换或“自动脱敏”。报告只给类别/路径，不输出命中的秘密。非普通文件、软链接/越界、冲突与超限等也会失败；失败后不继续提交。
- 精确批准路径的二进制与源 `HEAD` 中对应公开 blob 字节一致时可导出；新增或改动的批准二进制需要先人工审阅隐私和再分发权，再显式使用 `--allow-binary-changes` 重新准备。该开关只适用于政策精确列举的二进制路径，不放行任意二进制，不是语义扫描或永久批准。
- 可用 `--output NEW_EXTERNAL_DIRECTORY` 指定尚不存在的仓库外目录，其父目录必须存在且安全；拒绝源目录、源的祖先/子目录、已存在输出及软链接父路径。候选不继承源私人 Git 配置、hooks、过滤器、凭据或私有运行工件，只写入筛选后的公开文件与候选自身 `.git` 审计元数据。失败后可能留下不完整的新目录，不覆盖它来重试。
- 仅候选安装 `pre-commit` / `pre-push`：从当前运行的可信导出器复制 guard、scanner 和 policy 到候选 `.git/liyuan-public-guard/`，不执行候选中可编辑的同名脚本，也不继承远端 hooks。提交前审计整个实际暂存快照，推送前审计全部 outgoing commits，而非仅最终树；二进制 hash 绑定 `.git/liyuan-public-manifest.json`，准备后再次改动仍会拒绝。hook 不联网、不提供公开授权，也不替代人工审阅。

这是完整的筛选、准备和候选保护流程，不是“100% 脱敏”保证。未知秘密、二进制语义、来源、版权、遗漏及远端历史仍需审阅。`npm run docs:check` 与 `node scripts/check-public-data.mjs` 是补充检查，不替代候选 hooks 或公开授权；专项合成回归入口为 `npm run test:public-git`，范围见 [测试指南](../TESTING.md)。

## 忽略与公开边界

### 公开指南白名单

公开 Markdown 采用精确路径白名单，不按 `docs/*.md` 整体放行。入口为 `README.md`、`TESTING.md`、`AGENTS.md`、`CLAUDE.md`，部署指南为 `deploy/README.md`、`deploy/VPS-OPERATIONS.md`；`docs/` 仅批准[文档导航](DOCUMENTATION-INDEX.md)中的现行功能、架构、使用和开发维护指南，连同导航本身。批准路径由 `scripts/public-repository-policy.mjs` 明确列举，新增指南须先审阅再更新政策，不能由新链接自动获准。

验收、报告、审计、历史协议、交接、研究实施及 Release/版本历史不属于指南白名单；`PLAN-KNOWLEDGE-ENGINE`、`KNOWLEDGE-RESEARCH-VALIDATION` 和 `DATABASE-DETACHMENT` 文档也只在本地保留。Word 文档、文档图片、截图、日志和报告附件不导出、不上传、不随发行包发布。公开指南不得用本地 Markdown 链接指向这些资料；必要的职责、兼容限制和未验证范围留在指南中，证据引用改为“本地验收记录不随公开仓库发布”或已批准的长期指南。

本地验收记录不随公开仓库发布，即使旧记录已经被 Git 跟踪也不例外。源工作树中的记录、日期、失败历史和继承修改原样保留，不为公开而删除、重写或搬动。导出器应跳过源记录，并从显式公开基准的候选树中裁除旧记录，审阅对应删除差异；不能把基准树遗留记录当作自动批准的公开文件。候选树删除不清除旧远端提交、已有 clone 或已发行归档中的副本，也不授权改写远端历史；旧历史的隐私处置需要另行审阅与授权。

Git 与 Docker 排除未来新增的 `.liyuan-*`、`.rp-*` 命名空间，以及 `.local/`、旧 `.pi/`、实际本机配置、`.env` 文件、原子写入临时文件和浏览器输出。`.liyuan/` 下只有 `.liyuan/extensions/roleplay.ts` 是明确的公开例外，同目录其它扩展不因此自动公开。公共工具与示例配置仍属于公开文件。

已批准的跟踪素材精确限定为 `assets/brand/logo.png`、`assets/cards/default_Qingwu.json` 和 `assets/lorebooks/Mistvale.json`。新文件即使名为 `default_*` 也不自动获准公开。新增素材须明确来源，完成隐私与再分发审查，再精确更新政策；不能为了验证忽略规则而读取私人导入素材。

被忽略只表示被路径规则排除，不表示已解密、脱敏、可安全删除或获准公开。Git 忽略规则不会移除已跟踪文件，也不能阻止强制暂存。Docker 构建上下文过滤与发行归档过滤是独立政策，都不能替代对实际公开字节的审阅。

## 高级：源仓库手动暂存

使用 Node.js 22.19.0 或更新版本，并满足 manifest 的更高下限。隐私命令由 `scripts/check-repository-privacy.mjs` 执行，路径与内容政策由 `scripts/public-repository-policy.mjs` 定义。命令缺失或检查失败就是门禁未完成，不能称为通过。

```bash
npm run privacy:check
node scripts/check-public-data.mjs
```

`privacy:check` 检查工作树公开候选，即已跟踪文件与未被忽略的未跟踪候选，不遍历私有目录内容。`check-public-data.mjs` 独立检查已跟踪 Markdown 中个人 home 路径的泛化，以及两份 SDK 会话 fixture 的合成来源与生成字节。两项检查都不构成暂存或公开授权。

只有确需保留源仓库提交流程且明确获准提交后，才精确暂存预期路径；一般公开优先使用上方[一键公开 Git](#一键公开-git)。源仓库仍禁止整体执行 `git add .`、`git add -A` 或强加私有文件。以下仅以两个公开文档路径示范，实际路径须按授权范围选择：

```bash
git add -- README.md docs/PROJECT-STRUCTURE.md
git diff --cached --stat
git diff --cached
npm run privacy:staged
```

`privacy:staged` 检查整个实际索引快照，包括索引中未改动的文件与强制加入的忽略路径，读取索引字节而非较新的工作树字节。在获准的仅含公开内容的审阅环境中，还必须用完整 `git diff --cached` 审阅全部暂存改动；只看指定路径的 diff 不能证明索引其余内容符合提交意图。每次索引变化后都须重跑门禁。本机可手动以 `npm run privacy:staged` 执行提交前检查，该命令不会安装 hooks；一键流程只在独立候选中安装 hooks。

明确获准推送后，推送前逐一检查每个拟公开提交的快照：

```bash
npm run privacy:commit -- HEAD
# 将 HEAD 替换为每个拟公开提交的实际 ref。
npm run privacy:commit -- <ref>
```

`<ref>` 行是命令语法说明，执行时须替换为真实 ref。`privacy:commit` 检查该提交的树与 blob 字节，不依赖当前工作树或索引，也不扫描全部历史。须审阅全部拟推送提交，而非只看最新提交；被忽略的文件仍可能已存在于历史中。

隐私 CI 对每次 push 与 pull request 执行，不设分支或路径过滤；权限只读，checkout 不持久保存凭据。CI 使用 Node 22.19.0，无需安装依赖即运行工作树门禁、公共数据门禁与 `scripts/check-publication-range.mjs`。范围检查逐一审计 push/PR 引入的提交，避免“先加入秘密、随后删掉”只因最终树干净而通过；新分支检查全部可达历史，手动运行检查 HEAD，缺端点或浅历史则失败。CI 在推送后才运行，不能防止首次泄露，本地推送前门禁不可省略；检查失败应阻止后续合并或发行。

这些门禁是有限范围的路径与内容检查，不是全历史审计、二进制或语义隐私认证、全面秘密检测，也不是版权批准。`public-repository-policy.mjs` 的二进制例外只允许其中精确列举且已跟踪的现有路径，不按扩展名或目录整体放行；这些例外不进行二进制字节的语义秘密或来源扫描，内容变更仍须人工公开审阅。检查发现不得打印凭据、私人故事原文或命中的私人片段。合成测试不得抽取生产会话、thinking、截图或导入卡。

## 打包与部署

旧 `scripts/pack-for-linux.ps1` 已禁用，会在任何构建、复制或归档操作前失败。其旧递归复制与局部配置改写不能构成安全的公开边界。

使用独立、干净的公开 checkout，只包含已审阅的公开提交，不含运行数据或私人导入素材。在其中先执行公开门禁与合成发行政策测试，再调用维护中的打包器：

```bash
npm run privacy:check
node scripts/check-public-data.mjs
npm run privacy:commit -- HEAD
npm run test:release
powershell -NoProfile -File scripts/pack-release.ps1 -Target linux
```

按[发布流程](BRANCH-RELEASE-WORKFLOW.md)在该独立 checkout 中准备所需构建依赖与匹配的公开前端产物。分发前独立审阅最终归档。维护中的打包器不保证在含运行数据的 dirty 工作树中安全；打包器存在及合成测试通过，都不能证明任意文件或所有导入素材可安全公开。

按用户授权，维护/部署默认不新建手工本地备份或归档；GitHub 恢复源必须核验仓库 URL、精确 commit、匹配产物来源与校验和及可获取性。它只覆盖已推送、核验且获准公开的内容，不是 dirty、未推送提交、私人配置、会话、记忆或插件状态的备份。不得为“云端备份”上传这些私有内容，也不得为补齐恢复源自动提交或推送；操作若危及未覆盖内容，应停止并请求专项保留/恢复方案。

已有本地备份保留，不因新政策删除；原子保存 `.bak` 和更新器内部回退机制不禁用。旧更新脚本仍会归档，不能宣称已符合默认不新增手工归档的流程，见[现有脚本限制](LOCAL-UPSTREAM-UPDATES.md#现有脚本限制)。部署须另行授权，按 [VPS 运维](../deploy/VPS-OPERATIONS.md)执行恢复源核验、空闲检查、候选构建与运行验证，不回滚故事或数据库来回退代码。公开检查不会部署代码、批准 Release、修改私人设置、启用插件或把数据迁移到 `.local/`。
