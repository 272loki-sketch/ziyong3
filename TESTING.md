# 当前验证与测试边界

测试按离线领域、合成宿主、浏览器、原上游 fixture、真实模型与发行分层。每层只能证明自身范围；绿色离线结果不证明已部署、完整酒馆兼容或文学质量。本文列可执行入口与安全前提，不列固定“当前通过数”。实际脚本以根目录及 `web/package.json` 为准。

## 离线门禁

要求 Node.js **≥22.19.0**；本机可使用 `/opt/node22/bin/node`，且确保 npm 的 `node` 也满足版本。根目录和 `web/` 分别安装锁定依赖。不要为测试临时下载未经审阅的执行器。

```bash
npm ci
npm --prefix web ci
npm run verify
npm run test:release
```

| 命令 | 实际覆盖 |
| --- | --- |
| `npm run typecheck` | 根 `tsconfig.json` 的 src/server/跟踪扩展类型检查 |
| `npm test` | 串行运行 `test/*.test.ts`；部分测试有 fixture 或实验能力门禁 |
| `npm run test:frontend-version` | 前端版本回归 |
| `npm run test:connect-config` | 模型工具支持、默认/覆盖与未知字段保护 |
| `npm --prefix web run typecheck` | Web 类型检查 |
| `npm run verify` | 上述五项依次执行，任何失败中止 |
| `npm run test:release` | 临时合成目录中验证打包脚本的路径/ZIP 政策，不执行真实打包 |
| `npm run test:privacy` | 合成 Git 仓库验证路径、暂存/提交字节、脱敏输出与 CI 提交范围，不暂存生产工作区 |
| `npm run test:public-git` | 合成源/候选仓库验证一键公开快照、源不变、跳过私有路径、远端基准差异及候选 hooks，不公开生产数据 |
| `npm run docs:check` | 从现行入口检查本地链接目标存在性及公开路径政策，拒绝本地记录链接；不验证标题锚点，不递归本地记录或上游文档 |

`verify` 已包含后端 typecheck，但**不包含**全部 Web 浏览器测试、SDK fork src/dist 重编、真实供应商调用、原插件全部 fixture、实际发行包或三平台启动。CI 还有独立 unit/smoke/launcher/container job，不能仅凭 CI 名称称其等同完整 `verify`。

测试应隔离 HOME、TMPDIR、Agent 目录、素材和私有输出。部分测试使用本机 HTTP/WS、临时 Git、浏览器或 Python stdlib；端口权限/依赖失败应如实报告，不当业务通过。缺 fixture 的 skip 不计通过，显式运行的失败不抹掉默认 skip。

## 专项选择

| 修改范围 | 建议入口 |
| --- | --- |
| 连接与工具支持 | `npm run test:connect-config`、`node --test test/model-tool-support.test.ts` |
| 世界书管理 | `npm run test:lorebook-panel`、`npm run test:lorebook-browser` |
| 原数据库宿主 | `npm run test:database-plugin`、显式原插件浏览器门禁 |
| 酒馆来源/状态/预算 | `npm run test:tavern-plugins`、`npm run test:tavern-plugins-lifecycle` |
| NPC / Veridis | `npm run test:npc-parallel`、`npm run test:veridis-rewrite`、原 fixture 专项 |
| 行动选项 | `npm run test:global-options` |
| 小说开演 | `npm run test:novel-play` |
| 会话宿主生命周期 | `npm run test:rest-lifecycle` |
| 显示与原稿交付 | 下文原交付、脚手架、检查面板和先交付专项 |
| 导演室 / 请求观测 / MVU / 研究 | 下文对应后端和浏览器专项 |

只列建议，不代替评估修改影响。改共享引擎须验证两模式、保存、取消、切支和恢复；不因一项 UI 通过省略领域回归。

## 浏览器和构建

运行中的 `web/dist` 可能是部署产物。优先将候选构建到**仓库外临时目录**，不覆盖 inherited dirty 或生产静态文件。例如确认 `/tmp` 可用后：

```bash
npm --prefix web run build -- --outDir /tmp/liyuan-candidate-web
```

各 runner 使用自己的 dist 参数，不存在统一环境变量。常见入口为 `LIYUAN_LORE_DIST`、`LIYUAN_READER_DIST`、`LIYUAN_CONNECT_DIST`、`LIYUAN_GENERATION_MODE_DIST`、`LIYUAN_DATABASE_MANAGER_DIST` 与 `LIYUAN_DELIVERY_DIST`；先读所用 runner 的参数要求。构建不是部署，也不证明 SDK fork 已重编。

浏览器二进制/依赖可用 `LIYUAN_DATABASE_BROWSER_EXECUTABLE`、`LIYUAN_DATABASE_BROWSER_LIBS` 显式指定。全部截图、日志和报告放仓库外；只填合成内容，不读生产会话/Key，不写原卡。中文字体缺失造成截图等待时修复测试环境，不删测试或把超时计为通过。

### 导演室创作对谈

```bash
node --test test/outline-chat-continuity.test.ts test/outline-chat-rest.test.ts test/outline-chat-stream.test.ts test/side-model-result.test.ts
node --test web/test/director-chat.test.mjs
node scripts/check-director-chat.mjs --artifacts /tmp/liyuan-director-chat-report
```

覆盖 SSE 首字前状态/保活、SDK 增量、中文/换行、断流/取消、最近历史、`discussionId` 隔离、删除/清空与分支来源。浏览器核验提案不自动切走对谈、重开/删除、停止/重试、研究页失败隔离及手机布局。独立 canary 启动真实 `main.ts` 和本机合成兼容 API，不调用外部收费模型；成功保存后的 `done` 才算完成。

### 酒馆设置页回归

```bash
npm run test:tavern-plugins-browser
node --test test/tavern-plugin-settings-http.test.ts
npm run test:tavern-plugins-lifecycle
node scripts/test-tavern-native.mjs --fixtures /path/to/isolated/upstream-and-vendor-fixtures
```

前端合成宿主测试不等于原字节验收。原版 runner 必须显式 `--fixtures`，不提供即报错；默认测试缺 fixture 可 skip，绝不回落生产缓存。组合生成只用本机 stub。生命周期入口显式开启 Node 实验 module mock。

设置实测检查中文/主题、inline drawer、直接 legend 且非 `.TH-collapsible` 的助手 fieldset、原 Vue 内层、键盘与重复增强，以及保存重开/390px；输入值、用户 EJS/代码和故事不得被翻译。原字节与资产白名单/MIME/no-store 分开检查。`LIYUAN_TAVERN_UI_SCREENSHOTS` 仅用于仓库外合成截图。

真实宿主 canary 可用：

```bash
node scripts/check-tavern-canary.mjs --fixtures /path/to/isolated/fixtures --dist /tmp/liyuan-candidate-web
```

### 静态卷宗与iframe高度

```bash
node --test test/html-frame-reading.test.ts test/html-frame-program.test.ts test/htmlEmbed.test.ts test/card-dossier-view.test.ts
node --test web/test/html-frame-reading.test.mjs web/test/card-dossier-view.test.mjs
```

默认仅合成模板、正文和变量。`LIYUAN_DOSSIER_FIXTURE` 可显式提供仓库外合法只读模板，保留 `$1` 槽并只填合成正文；`LIYUAN_DOSSIER_SCREENSHOTS` 放仓库外。不执行生产卡脚本，不生成推演。核对来源/scope/swipe、转义、展开高度、390px、迟到隔离与缺数据不冒用别楼。

## 原数据库与记忆

```bash
npm run test:database-plugin
node --test test/database-plugin-prompt.test.ts test/database-plugin-system-messages.test.ts
node --test test/memory-narrative-window.test.ts test/memory.test.ts test/rp-memory.test.ts test/rp-memory-longrun.test.ts test/stage-compact.test.ts
LIYUAN_DATABASE_PLUGIN_TEST_SOURCE=/path/to/verified/index.js LIYUAN_DATABASE_PLUGIN_TEST_VENDOR=/path/to/verified/vendor npm run test:database-plugin-browser
LIYUAN_DATABASE_MANAGER_DIST=/tmp/liyuan-candidate-web LIYUAN_DATABASE_PLUGIN_TEST_SOURCE=/path/to/verified/index.js LIYUAN_DATABASE_PLUGIN_TEST_VENDOR=/path/to/verified/vendor npm run test:database-plugin-manager
```

显式提供已核验原资产与依赖，只使用临时库、合成卡/会话和模型/嵌入 stub，不下载到生产缓存。`LIYUAN_DATABASE_PLUGIN_TEST_LONG=1` 另启长纪要 fixture。拍前专项核对卡/全局世界书来源、snake_case/camelCase、防递归和原字段投送，真实超限/模型错误不能被通用提示吞掉或通过截断掩盖。

插件启用时停止旧自动剧情双写，关闭时回退旧路径；测试要保护原库和完整周期窗口/规范正文偏移。生产只读检查仅按授权核对 scope、游标、来源及向量空间，不读取或公开故事原文。“写→查→兄弟分支不可见”实测使用独立临时库和合成文本，不重生成生产故事。

## 正文与恢复

### 原作者一次交付与可见正则

```bash
node --test test/author-original-delivery.test.ts test/generation-format-parity.test.ts test/generation-mode-engine.test.ts test/regex-inspector.test.ts
node --test web/test/regex-manager.test.mjs web/test/tavern-plugins-navigation.test.mjs
```

验证完整原稿/后段/图片顺序、零拍后格式模型和门槛、pending 零模型重挂、已完成领域不重复，以及正则来源、深度、disabled、Worker 中止与静态安全。预览不执行卡脚本，也不证明任意交互卡全兼容。截断作者恢复还需 `test/author-recovery*.test.ts`、`test/agent-turn.test.ts` 与 `web/test/author-recovery.test.mjs`，半稿不能记为定稿。

### 正文先交付／后台结算

```bash
node --test test/generation-mode-engine.test.ts test/stage-performance.test.ts test/wire-performance-projection.test.ts
LIYUAN_DELIVERY_DIST=/tmp/liyuan-candidate-web LIYUAN_DELIVERY_ARTIFACTS=/tmp/liyuan-delivery-report node --test --test-concurrency=1 web/test/author-ready-delivery.test.mjs
```

合成慢后台核对：原稿/格式/pending 先 flush 后 `onAuthorReady`，后台不挡可读正文与发送，下一拍只排队，刷新不复活生成壳；取消、失败、切支、重 Roll 与恢复不撤回原稿/重复事实。对应 entryId/entryScope 的刷新只重读派生快照，不能重跑卡脚本。记录前台就绪和完整后台耗时，不将并行阶段简单求和。

### 检查面板实际展开

```bash
node --test test/display-scaffold-scope.test.ts test/postprocess.test.ts test/cardfront-pipeline.test.ts test/lorebook-cardfront.test.ts
node --test web/test/check-panel-expanded.test.mjs web/test/display-scaffold-scope.test.mjs web/test/global-options-messages.test.mjs
```

检查完整 HTML/对白反例、独立 rule_check 作用域、无 renderer 回退和父到子片段还原。必须实际展开/收起，逐字核对报告、inner/content 字面标签，不允许嵌套文档、人物气泡、PUA 标记、围栏或源码尾巴。覆盖桌面和窄屏；折叠壳与 pageErrors=0 不是充分验收。

## 请求查看器与MVU

```bash
node --test test/request-journal.test.ts test/mvu-assets.test.ts test/mvu-ui.test.ts test/mvu-view.test.ts test/mvu-management-http.test.ts
node --test --test-concurrency=1 web/test/request-inspector.test.mjs web/test/mvu-panel.test.mjs web/test/tavern-plugins-navigation.test.mjs
LIYUAN_MVU_NATIVE_FIXTURES=/path/to/verified-mvu node --test test/mvu-native.test.ts
LIYUAN_MVU_NATIVE_FIXTURES=/path/to/verified-mvu LIYUAN_TAVERN_PLUGIN_FIXTURES=/path/to/original-plugin-fixtures node --test test/mvu-settings.test.ts
```

MVU 原资产 fixture 必须显式提供，缺失 skip 不算原版通过。临时数据验证原 JSONPatch 方言、助手变量 API/事件、持久重绑与兄弟隔离；管理界面核对 busy、半稿、未结算拒绝、来源、未知状态、启停反馈、超时、迟到请求和390px主题。原设置交互须用原字节实际点击、保存重开，不能只以合成界面替代。

请求查看器只记录真实发送、逐次 usage 和墙钟；旧数据不重造、缺 usage 不估算。最终 SDK payload/回执需本机合成 SSE 链路验证，不把预览、假流或估算宣称真实账单。原载荷与 thinking 属于私有记录，不在公开报告中输出。

## 众生侧写与Veridis

### 离线来源／合同／管理／隔离回归

```bash
npm run test:npc-parallel
npm run test:veridis-rewrite
npm run test:npc-parallel-browser
npm run test:veridis-rewrite-browser
```

离线来源用临时 synthetic Git fixture 检查 blob/文件集 hash、依赖、symlink/越界、候选/空闲激活/CAS、永久坏 commit 与回退。合成 runtime 检查 Worker/浏览器隔离、凭据不外发、来源、revision、持久额度、取消及迟到结果。NPC 技术失败需同岗位最多一次修复、仍失败 pending；业务 reject 整批隔离，不能换故事补成功。Veridis no-hit 零调用、目标补集/选项/变量保护与空规则 skipped 分别验证。

### 显式原上游 fixture 与原管理页

```bash
node scripts/test-npc-parallel-integration.mjs --fixture /path/to/original-npc-repo
node scripts/test-veridis-rewrite-integration.mjs --fixture /path/to/original-veridis-repo
NPC_PARALLEL_FIXTURE_ROOT=/path/to/original-npc-repo npm run test:npc-parallel-browser
VERIDIS_REWRITE_FIXTURE_ROOT=/path/to/original-veridis/assets npm run test:veridis-rewrite-browser
```

integration 默认使用模型 stub，但**省略 `--fixture` 可能下载固定上游**；离线任务必须显式给合法 fixture。浏览器还需验证过的 vendor/二进制。Veridis 原工作台实际验上传、编辑、导出、保存/重开与 desktop/320/390px；高级 JSON 不是原工作台的替代证据。未知 API、危险旁路、busy/source/CAS 和 Key 不投送保持拒绝。

`--live-model` 会读取实际运维模型配置并收费，未经独立授权不得添加。这里列出的默认命令不授权读取生产配置或调用外部模型。上游 fixture、提示词、资源、vendor、截图和私有结果不进 Git 或包；结构/字节一致不证明语义完全等价。

### 隔离真实主程序与候选dist

```bash
node scripts/test-plugin-server-canary.mjs /tmp/liyuan-candidate-web
```

使用独立临时 HOME/Agent/合成会话和空模型配置，验证真实 main、管理入口、行动项及页面错误，不重启生产服务。该结果不能当成生产生态剧情或真实上游模型链路成功。

## Agentic Research

```bash
node --test test/agentic-loop.test.ts test/agentic-production.test.ts test/corpus-source-research.test.ts
node --test test/research-scope.test.ts test/novel-canon-research.test.ts test/web-source-reader.test.ts test/web-research.test.ts
node --test test/research-cache.test.ts test/research-privacy.test.ts test/research-engine.test.ts test/research-canon-engine.test.ts test/research-server.test.ts test/web-source-transport.test.ts
node --test web/test/research-settings.test.mjs
```

合成 server 测试隔离 HOME/Agent/卡/会话，真实 main/WS/SDK 只访问本机合成 API；TLS/CONNECT 用临时证书，不禁用证书验证。覆盖原著版本/位置/指纹、来源授权、预算缓存、兄弟分支、外发隐私、SSRF/pinning 与取消。参考循环测试不能代替实际作者接线。

真实评测另需显式授权的模型配置与私有输出，可能收费：

```bash
LIYUAN_RESEARCH_TEST_CONFIG_DIR=/path/to/authorized-test-model-config LIYUAN_RESEARCH_EVAL_OUTPUT_DIR=/path/to/private-evaluation-output node scripts/evaluate-agentic-research.ts director followup --allow-model-calls
```

场景有 ordinary/canon/conflict/followup/public/austen；austen 另提供合法公版文本 `LIYUAN_RESEARCH_PUBLIC_AUSTEN_FILE`。脚本只生成合成 Session，过滤 thinking，不写配置或 Key。多次同条件样本才可统计 P50/P95；不能从合成延迟、单题成功或 zero-cost catalog 推断真实性能/账单。

## 真实模型与发布

默认验证不授权外部收费请求或生产资料读取。真实端点探测必须单独说明模型、请求上限、超时、数据来源、输出位置与费用；只证明被测端点和场景。截断无可见文本、取消、缺回执不算成功；usage 缺失记未知，不归零、不把重叠样本累加为账单。

发行须独立验证最终归档、hash、版本、必需接线和平台启动。打包脚本有写入/构建副作用，应在审阅过的隔离公共候选中执行，不在含生产私有资料的 dirty 工作树试打包。部署还要空闲、已核验的 GitHub 精确提交及匹配产物恢复来源、候选切换和 health/hello/bundle/SW 核验；默认不新增手工本地备份。GitHub 不覆盖未推送改动或私人资料，恢复条件不足时停止，不以测试代替部署保护；已有备份、原子保存和更新器回退机制保留。

## 保护与报告

本地验收记录不随公开仓库发布。验收报告、日志、Word 文档、文档图片及全部截图仅保留在本地受限位置，不上传、不导出；即使旧记录曾被跟踪也不例外。公开只保留精确白名单中的长期测试方法和使用/开发指南，不链接本地证据。源记录与失败历史保持原样，公开候选须裁除基准树中的旧记录，但不能清除旧远端历史。

公开主入口是[一键公开 Git](docs/PRIVACY-AND-PUBLISHING.md#一键公开-git)，不是先在生产源仓库手动整理索引。`npm run git:public` 默认准备唯一仓库外、已暂存、无源历史的候选，不提交、不推送；更新已有分支必须显式使用 `--remote https://github.com/OWNER/REPO.git --branch main` 保留公开祖先。候选才安装暂存/全部 outgoing commits 审计 hooks 和二进制 hash manifest，源不安装 hooks、不改索引。私人/未批准路径只统计跳过，不读取内容；用户仍须检查遗漏、完整 diff 与许可，不能把测试通过称为“100% 脱敏”。

```bash
npm run test:public-git
npm run docs:check
node scripts/check-public-data.mjs
```

`test:public-git` 用临时合成 Git fixture 覆盖工作树字节优先于源索引、私有/未知路径跳过、源历史与配置不继承、新输出不覆盖、软链接/冲突/超限拒绝、已知凭据阻断、精确二进制改动需显式审阅，以及真实候选 hooks 拒绝暂存秘密和中间提交泄露。远端模式用隔离传输替身验证浅公开基准、增删改及祖先绑定，不访问真实公开远端或验证实际认证/推送。二进制测试只验证路径/hash 门禁，不扫描语义或批准版权；缺端点/浅新分支失败保持拒绝。

`docs:check` 核对其现行导航范围的链接目标存在及公开路径政策，拒绝本地记录链接，不检查标题锚点；`check-public-data.mjs` 的有限检查也只是补充。二者不替代候选保护、人工公开审阅、源历史审计或最终归档检查。

高级源仓库手动流程仍分别检查工作树与实际索引：

```bash
npm run privacy:check
npm run privacy:staged
```

工作树候选与实际暂存字节分别审计，入口由独立隐私工具任务接线；命令未存在/失败即未完成门禁。已有 `node scripts/check-public-data.mjs` 仅检查跟踪 Markdown home 路径与指定合成 SDK fixture，不能替代全候选、索引、历史和归档审查。范围见 [项目结构](docs/PROJECT-STRUCTURE.md#隐私检查)。

报告包含基线/修改范围、命令与环境、合成或原 fixture 来源、pass/fail/skip、失败/重跑、真实模型 attempts/usage 及未覆盖项，不输出故事、thinking、Key 或私人截图。旧结果不算本轮重跑；新门禁失败与既有基线问题分开。生产正文、既有记忆、配置/未知字段、私人 Skill 和插件缓存不因修复删除或重生成。
