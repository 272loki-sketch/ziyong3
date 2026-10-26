# 部署入口

- 需要 Node ≥ 22.19.0，依赖按锁文件安装；源码构建命令见 [README](../README.md#启动)。
- 私人配置从 `*.example.json` 复制后在本机填写，Key、角色卡、会话、私人 Skill 不进仓库。
- 服务器部署、回退、反向代理与访问保护见[运维](VPS-OPERATIONS.md)；隐私与推送见 [shipping](../docs/shipping.md)；测试见 [TESTING](../TESTING.md)。

## 安装脚本

安装器默认目标仓库为 `https://github.com/272loki-sketch/ziyong3.git`。先下载审阅，再执行：

```bash
curl -fsSL https://raw.githubusercontent.com/272loki-sketch/ziyong3/main/deploy/install.sh -o install.sh
# 先审阅 install.sh，再按其参数选择安装位置/端口
bash install.sh --no-start
```
