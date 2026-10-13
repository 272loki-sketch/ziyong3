# 梨园本地与上游同步

本文规定审阅与同步方法，不描述当前 checkout、远端分支、运行服务或公开 Release 状态。Git 提交、远端同步、部署和 Release 分别核验、分别授权；分支策略见 [BRANCH-RELEASE-WORKFLOW](BRANCH-RELEASE-WORKFLOW.md)。

## 审阅与同步

1. 先读维护约束、架构、两模式和正文执行合同。只读请求不改文件；开始前记录当前分支、remote、跟踪关系和继承 dirty，不能 reset、覆盖或自动 stash。
2. 确认具体来源 remote、目标分支、祖先和提交范围。获准 fetch 后审阅完整 commit 与 base diff，不把分支名、版本号或源码配置的目标地址当作同步/发布证明。
3. 优先在独立候选中合并。重点核对单作者、director 固定 3/2/2、先交付与后台锁、格式模型退役、来源/权限守卫和私人配置兼容；不得复活旧正文流程、替换用户配置或改写私人 Skill。
4. 在候选中按范围运行隐私、文档、类型、测试和构建门禁。fixture 使用合成或经授权的公开来源；缺 fixture、超时和失败如实保留，不把跳过写成通过。
5. 只有获得提交授权后才精确暂存并复核完整 `git diff --cached`；索引变化后重跑 `npm run privacy:staged`。推送前再核验全部待推提交、远端头和祖先关系，使用非强制推送。
6. 推送后重新核对远端头与版本文件。同步不重启服务、不改模型端点、不启用插件、不清理资料；部署和 Release 都须单独授权。

公开候选准备、路径白名单和门禁范围见 [PRIVACY-AND-PUBLISHING](PRIVACY-AND-PUBLISHING.md)；主流程见 [BRANCH-RELEASE-WORKFLOW](BRANCH-RELEASE-WORKFLOW.md)。

## 现有更新脚本限制

`scripts/update-local.sh` 是有副作用的旧便利脚本，不是只读同步流程：它要求特定分支和 clean 工作树，会创建本地归档、fetch/merge、安装依赖、直接构建前端，并可能重启 systemd 服务。其备份清单不覆盖所有现代插件、媒体、研究和运行路径；不能在继承 dirty、只读任务或未获相应归档/部署授权时运行。

`scripts/apply-update.mjs` 保留更新器内部旧版本快照及失败回退。这不是手工维护备份政策的替代，也不授权覆盖私人资料；原子配置写入的 `.bak` 和已有备份不因新流程而删除。修改/运行上述脚本均需独立授权。

## 私人资料与历史

真实配置、Key/OAuth/SSH、会话/正文/thinking、用户卡/预设/世界书、私人 Skill、媒体、记忆、插件缓存和备份留在原处，不进入公开候选。`.liyuan/extensions/` 只是明确的产品源码例外，不代表 `.liyuan/` 整体可公开；目录边界见 [PROJECT-STRUCTURE](PROJECT-STRUCTURE.md)。

公开指南只链接精确白名单中的长期文档。本地验收、研究实施、审计、交接和版本记录仍留在源目录，不链接到公开指南；准备公开候选时可裁除候选基准中的旧记录，但不得改写或删除源文件，也不能清除旧远端历史或旧发行包副本。具体隐私流程见 [PRIVACY-AND-PUBLISHING](PRIVACY-AND-PUBLISHING.md#公开指南白名单)。
