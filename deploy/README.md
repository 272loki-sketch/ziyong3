# 部署入口

- Node≥22.19.0，依赖按锁安装；源构建命令见 `../README.md`。
- 私人配置用示例复制后本机填值，不把Key、SSH/OAuth、角色卡、会话和用户Skill放进仓库。
- 当前正文架构/模型分工见 `../docs/ARCHITECTURE-OVERVIEW.md`、`../docs/MODEL-CONNECTIONS.md`。
- 按用户授权，维护/部署默认不新建手工本地备份或归档；先核验 GitHub 恢复仓库、精确 commit 与匹配产物来源、校验和及可获取性。GitHub 仅覆盖已推送、核验且获准公开的内容，不覆盖 dirty、未推送提交或私有资料；操作危及未覆盖内容时停止并请求专项方案，不自动备份或推送。
- 候选build与验证先在隔离路径；真实切换仍须单独授权、空闲、恢复源有效和版本/会话/私有数据保留核验，不回滚故事或数据库来回退代码。
- 不删除已有备份，不禁用原子 `.bak` 或更新器内部回退；旧更新脚本仍有归档副作用，不得仅凭本指南认定符合新流程；运行前须重新审阅脚本并另行授权。
- 不把历史模板的主机/端口/服务名或旧测试数字当当前运行环境。

完整检查表见 [运维指南](VPS-OPERATIONS.md)，测试见 [测试指南](../TESTING.md)。本地验收记录不随公开仓库发布，日志与截图也不上传。更新不是自动授权发布或删除旧仓库。

## 安装脚本来源

安装器源码默认目标仓库为 `https://github.com/272loki-sketch/ziyong3.git`，安装脚本地址见下方命令。此源码配置不证明目标远端已与当前工作树同步、包含此版本或已发布；先独立核验目标内容，再下载并检查脚本。公开源码不包含本机尚未发布的私有配置或候选部署。

```bash
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong3/main/deploy/install.sh -o install.sh
# 先审阅install.sh，再按其参数选择安装位置/端口
bash install.sh --no-start
```
