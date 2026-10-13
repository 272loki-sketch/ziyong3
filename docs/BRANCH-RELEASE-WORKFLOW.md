# 当前分支与发布流程

Git 提交、远端同步、本机部署与 GitHub Release 是四种独立操作。任何一项成功都不能推定另外三项完成。本文是长期流程，不记录某次分支头、部署版本或测试数字；操作时核验真实状态。

## 仓库与分支

- `main` 是当前已验收的公开产品线，不长期停留在旧基线。
- `local` 是本机增强/部署同步线；正常产品发布应与 `main` 同步，部署状态另记。
- `release/vX.Y.Z` 保留对应公开版本节点，供回看和回滚；建立版本分支不隐含创建标签或 GitHub Release。
- 原项目上游用显式命名 remote 或 review 分支；不能把本 fork 的 `main` 当成未更新的原上游。
- 已有版本分支更新须有明确授权并核对祖先，不能覆盖无关的新提交或默认为可移动标签。

每次操作先确认当前分支、remote URL、跟踪关系和远端头。普通快进优先；不能快进时停止协调或在授权的审阅流程中合并，不 force-push、不删除历史。历史清理的一次性授权不延续到未来。

## 推荐公开流程

一般公开使用[一键公开 Git](PRIVACY-AND-PUBLISHING.md#一键公开-git)，在源仓库执行准备命令即可得到已精确暂存的仓库外候选，不必改动源索引或搬走私人资料：

```bash
npm run git:public
```

默认不复制源历史，创建新的 `main` 历史，只适合首次公开，不适合覆盖已有分支。已有公开分支更新必须指定 HTTPS URL 和分支，以审计后的浅公开头作为祖先并暂存完整差异：

```bash
npm run git:public -- --remote https://github.com/OWNER/REPO.git --branch main
```

两种模式都不配置 remote。进入成功输出的候选目录后，核对跳过数量、遗漏、删除项和全部候选内容，再由用户明确选择提交消息与提交操作：

```bash
git diff --cached --stat
git diff --cached
git commit -m "Prepare public snapshot"
```

只有获得单独推送授权、确认目标和认证安全后才推送；URL 不含秘密、不写入 remote 配置，认证只走私有凭据管道。首次公开须确认目标为空或目标分支不存在，已有分支须与准备基准一致：

```bash
git push https://github.com/OWNER/REPO.git HEAD:main
```

候选 hooks 自动检查实际暂存内容、全部 outgoing commits 和 manifest 绑定的二进制字节，不替代人工审阅、许可或授权。不 force-push，不用 `-n` / `--no-verify`，不禁用 hooks；远端头变化或浅历史/端点检查失败时重新准备候选并审阅。精确批准二进制改动需先人工审阅再显式 `--allow-binary-changes`，不是任意二进制放行。准备和 hooks 不读取跳过的私人路径内容，也不提供“100% 脱敏”保证。

按改动选择下方验证与发行步骤；`docs:check`、`check-public-data.mjs` 是补充检查，不是公开授权或候选保护的替代。

## 高级：源仓库推送前门禁

1. 明确授权范围：修改、提交、推送、合并、标签、Release 与部署分别确认。没有授权不执行后续操作。
2. 查看 `git status`、`git diff`、`git log --oneline -10`，辨认继承 dirty 与本次改动。不要 reset、覆盖或自动 stash 他人的工作，只精确暂存授权文件；源仓库禁止 `git add .` / `git add -A`，一键候选的政策筛选后精确自动暂存不扩展此授权。
3. 运行工作树公开候选审计 `npm run privacy:check`，检查公共 fixture 来源与许可。私人配置、正文/thinking、素材、用户 Skill、插件缓存、媒体、截图和备份不得进入候选。
4. 暂存后用 `git diff --cached` 审阅实际提交，再运行 `npm run privacy:staged` 检查索引字节；磁盘已修改不代表索引同步。重新暂存后必须重查。
5. 根据修改运行 `npm run verify`、临时前端构建、`npm run test:release` 和必要专项。原 fixture、browser、真实模型与 skip 范围独立报告，不以总数替代支持面。
6. 审查拟推送的全部新增提交与 base diff，对每个提交执行 `npm run privacy:commit -- <ref>`，另运行 `node scripts/check-public-data.mjs`，不只看最新工作树。暂存扫描不替代历史或最终归档审查。
7. 核对远端头与祖先关系，使用非强制推送；之后重新查询远端头和版本文件，失败不称已同步。

隐私工具及范围见 [隐私与公开流程](PRIVACY-AND-PUBLISHING.md)；命令缺失/失败就是门禁未完成，不可降级为旧脚本“已扫描”。自动扫描不能替代合成来源、版权和人工候选审阅。

临时认证仅通过内存或私有凭据管道，不写 URL、Git 配置、代码或日志，不回显。提交消息遵循仓库风格；不跳 hooks、不擅自 amend。提交失败保留现场并修复，不能为凑成功绕过门禁。

## 构建与发行

在隔离、明确的公开源码候选中构建，验证版本、HTML、bundle、SW 和宿主资源对应关系。`web/dist` 可以作为产品产物跟踪，但不能手工修 bundle；`packages/` 的 src/dist 与 API fork 另有重编与回归要求。

`npm run pack:release` 和各平台入口调用 PowerShell 打包脚本，可能使用现有 dist 或在缺失时构建，并产生仓库外 `_release` 输出。它不是只读检查，也不应拿含生产私有资料的工作树试打包。使用审阅过的隔离候选，并核验最终归档文件集、必需产品接线、素材裁剪、平台启动器和校验和。`test:release` 仅在合成临时目录验证脚本政策，不证明真实包或三平台启动通过。

`.liyuan/extensions/` 是唯一明确隐藏运行目录中的产品接线例外，其余用户数据排除。Veridis 原源码、提示词、资源、vendor 和私有缓存不二传；第三方许可独立审查。

只有用户明确要求时才用 `gh` 创建 PR 或 Release。PR 审阅全部包含提交与基准差异；Release 绑定已核验的公开提交/标签及对应包，说明真实验证范围，不复制旧通过数。创建后返回实际 URL，未发布只报告未发布。

## 部署边界

分支同步不重启服务、不改模型连接或用户资料。部署先候选构建与离线/浏览器验证，再确认空闲、备份当前 dirty 源码、旧 dist 和实际私有路径，最后切换并核对 health/hello/bundle/SW。保留可回退产物和来源，回退产品代码不等于回滚私人故事或数据库。

部署不能偷偷启用插件、autoUpdate、旧渠道或重生成故事。具体运维与数据保护见 [VPS-OPERATIONS](../deploy/VPS-OPERATIONS.md)，上游审阅见 [LOCAL-UPSTREAM-UPDATES](LOCAL-UPSTREAM-UPDATES.md)。
