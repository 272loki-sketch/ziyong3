# Git、隐私与打包

只有一条目标：**GitHub 上只有梨园源码和插件宿主代码，私人数据永远留在本地。** 这是少数不可逆的事之一，所以这里的检查是硬门禁。部署见[运维](../deploy/VPS-OPERATIONS.md#部署)。

## 什么能公开

公开范围是白名单，由 `scripts/public-repository-policy.mjs` 定义（`.gitignore` 是它的镜像）：

- 源码：`src/`、`server/`、`web/`、`packages/`、`test/`、`scripts/`、`skills/` 内置 Skill、`.liyuan/extensions/roleplay.ts`
- 根文件：manifest、锁文件、启动器、Dockerfile、示例配置 `*.example.json`
- 文档：`README.md`、`AGENTS.md`、`CLAUDE.md`、`TESTING.md`、`docs/` 下白名单里的指南、`deploy/` 两篇、`licenses/README.md`
- 素材：只有 `assets/brand/logo.png`、`assets/cards/default_Qingwu.json`、`assets/lorebooks/Mistvale.json`

不在白名单的路径一律不导出，也不读内容。

## 什么永远不公开

| 类别 | 路径 |
| --- | --- |
| Key、连接、模型岗位 | `liyuan.agent.json`、`liyuan.agent.meta.json`、`liyuan.config.json`、`liyuan-profiles/`、`.env*` |
| 角色卡、世界书、预设、人设 | `.liyuan-lore/`、`.liyuan-personas.json`、`assets/` 下非白名单文件、`presets/` 下非默认文件 |
| 会话、正文、记忆、记录 | `~/.liyuan/agent/`、`.liyuan/`（含 request-journal、play-slots）、`.liyuan-memory/`、`.liyuan-state/`、`.liyuan-worldline/` |
| 私人 Skill | `.liyuan-stage-skills/`、`.liyuan-skills/` |
| 插件缓存与状态 | `.liyuan-database-plugin/`、`.liyuan-tavern-plugins/`、`.liyuan-npc-parallel/`、`.liyuan-veridis-rewrite/`、`.liyuan-fish-tts/`、`.liyuan-research/` |
| 媒体、上传、备份 | `.liyuan-media/`、`.liyuan-audio/`、`.liyuan-uploads/`、`data/`、`.backup/`、`*.bak` |
| 本地记录 | 验收、报告、截图、日志、`.liyuan-history/`、`docs/` 下非白名单文件 |

经验法则：`.liyuan-*`、`.rp-*`、`.local/` 开头的路径全部私有。被 Git 忽略不等于可以删，原路径保留。

## 提交

在源仓库提交：

```bash
git add -- <精确路径>          # 不用 git add . / -A
npm run privacy:staged         # 每次暂存区变化后重跑
git commit -m "..."
```

本地提交随任务授权。推送前对每个要公开的提交跑 `npm run privacy:commit -- <ref>`。

## 推送

推送需用户同意。两种方式：

- **私有备份分支**：提交都过了 `privacy:commit` 后，直接 `git push <remote> <branch>`。
- **公开仓库**：用导出器生成干净的候选仓库，不在源仓库里整理索引：

  ```bash
  npm run git:public -- --remote https://github.com/OWNER/REPO.git --branch main   # 更新已有分支
  npm run git:public                                                               # 首次公开（新历史）
  ```

  进入它输出的候选目录，`git diff --cached` 审阅后提交、推送。候选目录装有 pre-commit/pre-push 隐私 hook。

规则：

- 不 force-push，不 `--no-verify`；hook 或检查失败就是没通过，修好再来。
- URL 里不放 Token，认证走私有凭据管道。
- 扫描命中凭据、私钥、带认证的 URL 时直接阻断，不自动脱敏；报告只给类别和路径。
- 白名单里的二进制改了要先人工审阅，再加 `--allow-binary-changes` 重新导出。
- 推送后 CI（`.github/workflows/privacy.yml`）还会复查，但它在推送之后才跑，本地检查不能省。

## 新增公开文件

新增文档或素材要公开时，同步改：

1. `scripts/public-repository-policy.mjs`（`approvedDocumentation` / `assets` / `roots`）
2. `.gitignore` 里对应的 `!/docs/<name>.md`
3. 文档入口还要改 `scripts/check-docs.mjs` 的 `entries` 和 `test/documentation-links.test.ts`

素材先确认来源和再分发许可。

## 打包

```bash
npm run test:release
powershell -NoProfile -File scripts/pack-release.ps1 -Target linux
```

只在干净的公开 checkout 里打包，不在含私人数据的工作树里打；打完审阅归档内容。Veridis 原源码与资产不进公开仓库、dist 或发行包。

## 分支

- `main`：公开产品线；`local`：本机部署线；`release/vX.Y.Z`：版本节点。
- 合并上游在候选分支里做，审阅完整 diff，重点看单作者、3/2/2、原稿先行有没有被破坏。
- Git 同步、部署、Release 是三件独立的事，分别核对。
