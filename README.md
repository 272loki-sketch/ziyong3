# 梨园 Liyuan

梨园是面向角色扮演与小说创作的 Web 客户端：由同一个主 Agent 写作，以会话分支保存故事，并把创作讨论、世界状态、记忆和显示效果分开管理。可导入 PNG/JSON 角色卡、预设和世界书，按岗位连接不同模型，在浏览器中持续创作。

本页介绍产品与入门。源码版本以 `package.json` 为准；源码、运行中的服务、远端分支和公开 Release 是不同状态，不能互相推定。

## 当前功能

- **直出 `direct`**：已有资料、记忆与世界/生态投影，经正常文学导演准备，由单主 Agent 输出普通文本。不是省略资料与导演职责的一发 API。
- **导演 `director`**：同一主 Agent 主持三份证据、两个角度、起草、两份审阅，再自行保留或修改并定稿。专家只报告，不代写正文。
- **正文先交付**：完整原稿和卡格式持久化后立即可读；账本、世界/生态、数据库和插件继续后台整理。此时可发送下一条，但忙碌时仅排队，尚未写入会话树或收到服务端 accepted ACK；出队后先通过必要的上一拍来源校验与恢复，失败则输入不受理、保留草稿。
- **分支与恢复**：Session Tree / `rpNarrative` 保存故事事实，`rpAuthorDraft` 保留完整作者交付。恢复缺失结算不重写故事、不重复已完成事实。
- **角色卡与世界书**：卡内世界书自动加载，独立挂载和按卡补充分别管理。写回必须绑定来源，原关闭模块不会因显示规则被开启。
- **导演室**：创作对谈、独立讨论、大纲提案、研究、长文消化和只读诊断。对谈不是第三种正文模式，提案不是已发生的故事。
- **按需研究**：作者在既有工具循环中核查本地原著或安全公网资料，保留实际读取出处。研究回执不直接成为故事事实，也不等于角色知情。
- **独立模型岗位**：主演、专家、世界、生态、记忆和研究分别配置；工具调用支持按模型保存。嵌入连接独立于聊天模型。
- **插件宿主**：原数据库、酒馆助手、提示词模板及 MVU 通过受限宿主适配运行。NPC Parallel 提供场外经历候选，由同一生态链采纳；Veridis Rewrite 只提供可选的局部显示润色。
- **只读观测**：提示词查看器展示实际发送记录、逐次耗时和可获得的 usage。没有回执的数据不估算为真实账单。
- **历史图片展示**：旧生图系统已退役，仅保留历史图片和提示的只读显示。

插件原文件完整不代表全部酒馆 API、任意社区卡或上游未来版本等价。Veridis 的结构保护也不保证文意完全不变；显示投影不覆盖原稿、事实、变量、MVU、数据库或记忆。详见[两模式](docs/GENERATION-MODES.md)、[执行合同](docs/PLAN-ROUND-FLOW.md)和各插件指南。

## 启动

要求 Node.js **≥22.19.0**。根目录与 `web/` 是两个独立 npm 包，首次从源码安装需分别安装依赖。在新安装目录中执行：

```bash
npm ci
npm --prefix web ci
cp liyuan.agent.example.json liyuan.agent.json
cp liyuan.config.example.json liyuan.config.json
npm run web:build
npm run web
```

示例复制仅用于首次初始化，已有配置不要覆盖。在本机连接面板或私有配置中填写连接信息，不把 Key 写入示例、截图或提交。浏览器访问控制台打印的地址；启动器 `start.sh`、`start.bat`、`start.command` 与容器安装见[部署指南](deploy/README.md)。发行包已有匹配的 `web/dist` 时无需重建前端。

服务含私人创作资料与管理接口，不应无鉴权直接暴露到公网。反向代理、访问控制和备份见[运维指南](deploy/VPS-OPERATIONS.md)。远程安装脚本应先下载审阅，再执行；不要把未经审阅的网络脚本直接交给 shell。

源码配置的安装器目标地址为 `https://raw.githubusercontent.com/272loki-sketch/ziyong3/main/deploy/install.sh`，更新检查默认仓库为 `272loki-sketch/ziyong3`。这是源码目标配置，不证明远端已与当前工作树同步、包含此版本或已发布；先独立核验目标内容，再下载审阅脚本。此地址不是自动升级或覆盖已有安装的授权。

## 使用顺序

1. 配置可用模型连接，核对默认主演和各岗位；根据实际模型能力设置“支持工具调用”，新模型默认支持。
2. 导入角色卡，选择用户身份与启用预设。原始材料决定写法和格式，系统 Skill 负责执行协议。
3. 检查卡内世界书与额外挂载，不为显示而复制内嵌书，不自动复活停用项。
4. 在输入框选择直出或导演。模式绑定提交的输入，排队、重放和重 Roll 不随之后的按钮状态变化。
5. 等待完整作者交付。后台整理时可继续提交，派生面板可能稍后更新；后台失败不撤回已保存原稿。
6. 按需打开导演室讨论方向、研究或审阅提案。同一故事可有多个独立对谈；删除/清空只追加分支标记，不物理擦除会话原记录，也不删除正文或大纲。
7. 可选安装插件并分别启用。安装不自动启用，自动更新也须显式配置；原数据库和浏览器插件有额外运行依赖与兼容门禁。
8. NPC 须显式启用鲜活世界并配置 `npcParallel`；Veridis 使用独立 `veridisRewrite` 岗位。缺岗位不能借用主演。检查采纳/跳过/失败收据，不把下载或 `changed` 当成语义验收。

## 维护

### 一键准备公开 Git

在日常工作目录执行：

```bash
npm run git:public
```

命令自动生成仓库外的独立公开 Git 工作区并暂存候选：不复制私人运行目录、实际配置或本地 Git 历史，不改变当前暂存区，也不提交或推送。公开文档仅限明确批准的长期介绍、使用和开发指南；本地验收、研究实施、审计、交接、版本记录以及日志、Word 文档、文档图片和截图从不导出，源目录中的记录仍原样保留。输出目录内自动安装提交前和推送前隐私门禁。疑似秘密、未审阅的二进制变化或不安全路径会阻止准备，不静默改写代码。

更新已有 GitHub 分支时，显式指定公开基线：

```bash
npm run git:public -- --remote https://github.com/OWNER/REPO.git --branch main
```

远端模式读取指定分支并准备增删差异，无远端模式创建无历史的全量候选。公开基准树中的本地记录也须在候选中裁除；这不删除源文件，不能清除旧远端提交中的历史副本。下一步在输出目录审阅 `git diff --cached`，核对指南白名单和记录删除差异，确认后正常 commit/push。完整操作与限制见[一键公开流程](docs/PRIVACY-AND-PUBLISHING.md#一键公开-git)。

```bash
npm run verify
npm run test:release
```

`verify` 包含后端 typecheck、后端测试、前端版本检查、模型工具配置回归与 Web typecheck，不包含完整浏览器、真实模型、SDK fork 重编或实际三平台打包。完整分层、fixture 要求及临时构建见[测试指南](TESTING.md)。文档链接检查使用 `npm run docs:check`；隐私候选树、暂存内容与指定提交分别使用 `npm run privacy:check`、`npm run privacy:staged` 和 `npm run privacy:commit -- <ref>`，边界见[隐私与公开流程](docs/PRIVACY-AND-PUBLISHING.md)。

升级必须先验证候选构建，再核对空闲与备份，最后独立部署。Git 同步不授权重启、改配置、清空记忆或重生成生产故事。

## 文档入口

| 需要 | 入口 |
| --- | --- |
| 按主题查功能与边界 | [文档导航](docs/DOCUMENTATION-INDEX.md) |
| 理解源码与数据责任 | [架构](docs/ARCHITECTURE-OVERVIEW.md)、[项目结构](docs/PROJECT-STRUCTURE.md) |
| 理解作者、交付与恢复 | [正文模式](docs/GENERATION-MODES.md)、[执行合同](docs/PLAN-ROUND-FLOW.md) |
| 配置模型、资料和记忆 | [模型](docs/MODEL-CONNECTIONS.md)、[世界书](docs/LOREBOOKS.md)、[数据库](docs/DATABASE-PLUGIN.md) |
| 创作讨论与研究 | [导演室](docs/DIRECTOR-ROOM.md)、[研究](docs/AGENTIC-RESEARCH.md)、[小说开演](docs/NOVEL-PLAY.md) |
| 测试、同步与发布 | [测试](TESTING.md)、[同步](docs/LOCAL-UPSTREAM-UPDATES.md)、[发布流程](docs/BRANCH-RELEASE-WORKFLOW.md) |

## 隐私与许可

私人卡、预设、人设、世界书、会话、正文、thinking、API/OAuth/SSH 凭据、用户 Skill 覆盖、媒体、截图、记忆、插件缓存和备份不进入公开 Git 或发行包。公开测试只使用合成且可溯源的材料。`.liyuan/extensions/` 是产品源码例外，不代表 `.liyuan/` 整体可公开。

本地验收记录不随公开仓库发布。记录即使曾被 Git 跟踪也不因此获准再次公开；公开导航不链接本地记录、Word 文档、文档图片或截图。保留失败、超时和未知 usage 的本地证据，不把指南清理解释为删除记录或撤销其事实。

项目许可为 **PolyForm-Noncommercial-1.0.0**，以 [LICENSE](LICENSE) 为准；第三方方法与素材见[来源说明](docs/THIRD-PARTY-INSPIRATION.md)，组件署名与许可文本见[许可说明](licenses/README.md)。这些声明不替代具体组合的独立许可审查。第三方插件遵守自身许可，不能用梨园许可代替。**Veridis 上游限制原版本体直接二传**：原源码、提示词、资源及依赖只在用户私有下载缓存中使用，公开仓库和发行包仅包含梨园宿主。
