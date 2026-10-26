# 测试

本篇回答"改了什么、跑什么、怎么报告"。脚本以根 `package.json` 与 `web/package.json` 为准。

## 什么时候跑什么

按 [AGENTS 防御分级](AGENTS.md#防御分级) 取用，不是每次都全跑。

| 层 | 什么时候 | 阻断吗 |
| --- | --- | --- |
| 相关测试（见[找测试](#找测试)） | 边改边跑 | 是 |
| `npm run verify` | 提交或部署前一次 | 是 |
| 浏览器测试 | 改了对应前端或插件宿主，只跑相关文件 | 是 |
| 原插件 fixture 测试 | 改了宿主适配或原插件版本 | 有 fixture 时是；缺 fixture 记 skip |
| 真实模型一拍 | 改了引擎时序、后台结算、提示词装配或模型路由 | **否**，只看有没有新的代码类错误（见[真实模型](#真实模型)） |

改动前就失败的测试单列为基线失败，不算回归，也不在本次顺手修（除非这就是本次任务）。

## 环境

- Node ≥ 22.19.0；根目录和 `web/` 分别 `npm ci`。
- 测试自建临时 HOME、TMPDIR、Agent 目录与素材，fixture 一律合成；不读生产卡、会话、Key 或插件缓存。截图、日志放仓库外。
- 部分测试需要回环 HTTP/WS、子进程、临时 Git、Playwright Chromium；环境缺失导致的失败如实报告，不算通过。低内存主机把 verify 和浏览器测试串行跑。

## 常规命令

```bash
npm run verify
```

`verify` 依次跑：根 typecheck → `npm test`（全部 `test/*.test.ts`，串行）→ `test:frontend-version` → `test:connect-config` → Web typecheck，任一失败即停。它**不含**浏览器测试、原插件 fixture 测试、SDK 重编和真实模型。

| 命令 | 用途 |
| --- | --- |
| `npm run docs:check` | 入口文档的本地链接与公开路径政策 |
| `npm run privacy:check` / `privacy:staged` / `privacy:commit -- <ref>` | 工作树 / 暂存区 / 指定提交的隐私扫描（见 [shipping](docs/shipping.md)） |
| `npm run test:privacy`、`test:public-git`、`test:release` | 隐私扫描、公开导出、打包政策本身的测试 |

## 找测试

测试文件按模块命名：改 `src/stage/supplementary.ts` 就跑 `test/supplementary-*.test.ts`，改 `web/src/components/MvuPanel.tsx` 就跑 `web/test/mvu-panel*.test.mjs`。用 `node --test <文件…>` 跑后端，`node --test --test-concurrency=1 <文件…>` 跑 `web/test/`。`package.json` 里有按领域打包的脚本（`test:tavern-plugins`、`test:database-plugin`、`test:npc-parallel`、`test:novel-play`、`test:fish-tts`、`test:novelai` 等，带 `-browser` 后缀的是浏览器版）。

不能从文件名看出来的对应关系：

| 改动 | 额外要跑 |
| --- | --- |
| 共享引擎、两种模式、一拍时序、后台结算 | `test/generation-mode-engine.test.ts`（主回归），并按 [architecture 改引擎时](docs/architecture.md#改引擎时) 说明不变量 |
| 附属补交、原稿交付 | `supplementary-engine`、`supplementary-wire`、`author-original-delivery`、`generation-format-parity` |
| 显示与正则 | `display-scaffold-scope`、`cardfront-pipeline`、`cardSkin`、`postprocess`、`regex-*`；Web 的 `check-panel-expanded` 要在桌面和窄屏实际展开/收起 |
| 世界书 | `worldbook-bindings`、`lorebook*`、`stage-native-worldbook`、`database-plugin-lorebooks`；`npm run test:lorebook-panel` |
| 模型岗位与配置保存 | `model-routing`、`rest-config-persistence`、`database-director-model-sync`；`npm run test:connect-config` |
| 众生侧写 | `npm run test:npc-parallel`（含生态接入 `npc-parallel-ecology`） |
| 合成 canary 的进程清理 | `test/canary-lifecycle.test.ts` |
| 文档、发布、隐私政策 | `npm run docs:check`、`test:privacy`、`test:release`；`documentation-*`、`deploy-install-safety` |
| SDK（`packages/*/src`） | 按该包的 `build` 重编并提交匹配的 `dist`，再跑 `verify`；`verify` 本身不重编 |
| 导演室 | 另有 canary：`node scripts/check-director-chat.mjs --artifacts <仓库外目录>` |

## 浏览器测试

- **用候选构建**：很多 App 级测试默认读 `web/dist`，那可能是部署产物。先构建到仓库外：`npm --prefix web run build -- --outDir /tmp/liyuan-candidate-web`，再用对应 runner 的变量指过去（`LIYUAN_TEST_WEB_DIST_DIR` 等，见各测试文件头）。组件级测试用 esbuild 直接打包源码，不需要构建。
- **浏览器**默认用 Playwright 的 Chromium；缺共享库时用 runner 自己的变量指定（如 `LIYUAN_DATABASE_BROWSER_EXECUTABLE` / `_LIBS`）。中文截图用 `LIYUAN_UI_CJK_FONT` 指定字体。字体或环境导致的超时修环境，不删测试。
- 多个浏览器测试文件一起跑偶有串扰时，逐文件分进程跑。

## 原插件 fixture

原字节测试必须显式提供仓库外、已核验的上游资产；缺了就 skip（skip 不算通过），绝不回落到生产缓存。

| 门禁 | 提供方式 |
| --- | --- |
| 酒馆助手/模板 | `npm run test:tavern-plugins-native -- --fixtures <dir>`；`LIYUAN_TAVERN_PLUGIN_FIXTURES` |
| 助手前端 API | `LIYUAN_TAVERN_API_FIXTURES=<dir> node --test test/tavern-helper-api-native.test.ts` |
| MVU | `LIYUAN_MVU_NATIVE_FIXTURES`、`LIYUAN_MVU_UI_FIXTURES` |
| 原数据库 | `LIYUAN_DATABASE_PLUGIN_TEST_SOURCE` + `LIYUAN_DATABASE_PLUGIN_TEST_VENDOR`，再跑 `test:database-plugin-browser` |
| Veridis | `node scripts/test-veridis-rewrite-integration.mjs --fixture <repo>`（省略 `--fixture` 会下载上游） |
| 卷宗模板 | `LIYUAN_DOSSIER_FIXTURE` |

## 合成 canary

`check-director-chat.mjs`、`check-tavern-canary.mjs`、`test-plugin-server-canary.mjs` 用隔离状态和本机合成请求启动真实 `server/main.ts`，证明服务能起、接口能通，不证明真实模型或生产部署。它们自带探针时限和子进程清理（`scripts/subprocess-cleanup.mjs`）；外层再套一个 `timeout` 即可。跑完确认本次启动的进程已退出，清理只针对自己启动的 PID，不按端口或进程名杀。

## 真实模型

默认命令都不调用外部模型、不读生产配置。真实模型测试需用户授权。

- **测试模型**：默认统一用 CPA 渠道的 `cpa_luna/gpt-6-luna`，在隔离副本的配置里把作者、全部 `stepModels`、原数据库填表/召回和 `analysisRecoveryModel` 都指向它。换模型需用户点名。这不是生产岗位推荐。
- **隔离工作区**：复制卡、预设、世界书、配置和插件原资产，不复制故事状态与记忆；独立 HOME、Agent 目录、新会话。经真实 `server/main.ts` 与 WS 发送输入，等整拍结束读收据、请求记录与耗时。工作区可反复使用，不必每次重建。

**定位：观察，不是门禁。**

- 默认 `direct`、`director` 各跑 **1 拍**；只有本次改动就是要修某个真实运行问题时才多跑。
- **阻断上线的只有**：正文没交付；服务崩溃或卡死；出现由本次代码引起的错误（异常、状态机走错、收据与实际不符、来源串线）。
- **只记录、不阻断**：供应商 524/限流/超时导致某个后台领域 pending 或 failed（产品本来就在下一拍按收据补）；文学上是否采用了参考；合法的"无变化"结果。CPA 前置代理约 120 秒读超时，长任务的 524 记为供应商超时。
- 同一个上游错误不重跑去"等它好"；记下请求 id 和错误类别。验收脚本判错就修脚本，对同一份结果重新判一次。
- 记录 attempts、HTTP 结果、usage（缺失记未知）和墙钟。截断、无可见文本不算成功。不自动换模型或改私人配置重试；不点生产付费按钮。

其它需要授权的真实调用：`scripts/test-veridis-rewrite-integration.mjs --live-model`；研究评测 `scripts/evaluate-agentic-research.ts ... --allow-model-calls`（变量见脚本）。

## 一拍核对清单

按改动挑相关条目，没做的写进"未覆盖"。第 1–3 条是一拍的最低核对。

1. **受理**：accepted ACK、保存的 user id 与模式。必要恢复失败时没有新 user 落树、草稿保留。
2. **作者交付**：`rpNarrative`、完整 `rpAuthorDraft`、显示引用一致；director 有 3 证据、2 角度、主稿、2 审阅和定稿。记录作者就绪耗时。
3. **后台**：等 `onTurnEnd`，逐个领域看 complete/pending/failed/skipped 和来源。
4. **附属补交与 MVU**：作者交了闭合块就不补；没有要求就 skipped 不发请求；变量补交失败时 MVU 留 pending，恢复后只补缺的。
5. **派生结果被用上**：在下一拍实际 payload 里找到合法来源的派生参考，再看作者是否合理采用。
6. **恢复与隔离**：制造一次可控领域失败，恢复后已完成领域不重跑、原稿不变；切分支/卡后旧请求不能写入新来源。
7. **前端**：桌面与窄屏；插件的未保存离开保护、保存失败重读；导演室的草稿恢复、对谈隔离、断流保留输入。导演室通过不代表 director 模式通过。

## 报告格式

一次改动或一次发布写一段，不另建证据矩阵或哈希链：

```text
基线：<commit>（含/不含未提交改动）
命令：<跑了哪些，fixture 来源>
结果：pass N / fail N / skip N（失败与基线问题分开）
真实模型：否 | 是（模式、拍数、正文是否交付、外部错误类别与次数）
未覆盖：<没跑的层>
```

测试只证明它覆盖的那一层：离线测试不证明真实模型，真实一拍跑通不证明文学质量，无报错不证明显示完整。旧结果不算本轮重跑。报告不输出故事原文、thinking、Key 或私人截图。
