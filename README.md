# 梨园 Liyuan

梨园是面向角色扮演与小说创作的 Web 客户端：同一个主 Agent 写作，故事以会话分支保存，创作讨论、世界状态、记忆和显示效果分开管理。可导入 PNG/JSON 角色卡、预设和世界书，按岗位连接不同模型。

## 功能

- **两种写作模式**：直出 `direct` 由主 Agent 直接写；导演 `director` 先收集三份证据、两个角度，起草后经两份审阅，再由主 Agent 定稿。专家只报告，不代写。
- **正文先交付**：完整原稿保存后立即可读，账本、世界、记忆和插件在后台整理；后台失败不撤回正文。
- **分支与恢复**：故事事实只在会话树里；缺失的后台结算可按收据补齐，不重写故事。
- **角色卡与世界书**：主世界书按卡绑定解析，附加/聊天/全局/补充分别管理，不自动开启已关闭的模块。
- **导演室**：创作对谈、大纲提案、研究、长文消化、小说开演；对谈草稿在当前浏览器标签页按工作区、分支和对谈隔离保存，窄屏可直接选择工作区。
- **鲜活世界**：可选的世界推演与人物生态，把活动、公开传播和已结束事件的后果作为后续写作参考；仍由主 Agent 决定如何写入正文。
- **剧情选项**：后台从已消化的卡库筹备日常剧情入口，点击只填入草稿。
- **模型岗位**：主演、专家、世界、生态、记忆、研究等各自配置，用你手上有的 API。
- **插件宿主**：原数据库、酒馆助手、提示词模板、MVU、Veridis Rewrite 以原文件运行，默认关闭。
- **众生侧写**：内置模块，每拍为镜头外的人物写"此刻在做什么"，经鲜活生态采纳后供后续写作参考，默认关闭。
- **多卡并行**：最多同时运行三个独立卡位，可交给完整主窗口继续。
- **Fish Audio 配音**、**NovelAI 生图**：默认关闭，手动触发。
- **提示词查看器**：查看实际发送的请求、耗时和 usage。
- **三套背景**：默认、护眼、夜晚，只存在浏览器里。

## 启动

需要 Node.js ≥ 22.19.0。

```bash
npm ci
npm --prefix web ci
cp liyuan.agent.example.json liyuan.agent.json     # 首次；已有配置不要覆盖
cp liyuan.config.example.json liyuan.config.json
npm run web:build
npm run web
```

服务器一键安装脚本：`https://raw.githubusercontent.com/272loki-sketch/ziyong3/main/deploy/install.sh`（先下载审阅再执行）。

在连接面板里填写你的 API。启动器 `start.sh` / `start.bat` / `start.command` 与容器安装见[部署](deploy/README.md)。服务含私人资料，不要无密码暴露到公网，反向代理与访问控制见[运维](deploy/VPS-OPERATIONS.md)。

## 使用

1. 配置模型连接，设置默认主演和各岗位。
2. 导入角色卡，选择人设和预设。
3. 在输入框选择直出或导演，发送。
4. 后台整理时可以继续发送，会排队执行。
5. 按需打开导演室、插件中心、多卡并行。插件中心的“读取全部状态”只检查开关、安装与依赖；本拍是否完成要看详情收据。

正文可读不等于后台全部完成；遇到 pending 或失败，先看[收据与请求记录](docs/diagnostics.md)，按来源恢复缺失领域。

细节：[多卡并行](docs/features.md#多卡并行与主窗口接管)、[背景](docs/features.md#背景主题)、[配音](docs/features.md#fish-audio-配音)、[生图](docs/features.md#novelai-生图)、[日常选材](docs/planning.md#日常选材)、[模型岗位](docs/models.md#岗位)。

## 维护

维护者（含 AI Agent）从 [AGENTS.md](AGENTS.md) 开始。测试见 [TESTING](TESTING.md)，推送见 [shipping](docs/shipping.md)，部署见[运维](deploy/VPS-OPERATIONS.md)。

## 隐私与许可

公开仓库只含梨园源码与插件宿主代码。角色卡、预设、人设、世界书、会话、API Key、私人 Skill、记忆、插件缓存都只在本地。

项目许可为 **PolyForm-Noncommercial-1.0.0**（见 [LICENSE](LICENSE)）。七份导演 Skill 适配自 Luker（AGPL-3.0-only），来源与组件许可见 [materials](docs/materials.md#来源与署名) 和 [licenses](licenses/README.md)。第三方插件遵守各自许可；Veridis 上游禁止二次分发，原文件只在你本地的私有缓存里使用。
