# 资料与显示

资料是主 Agent 写作时读的东西：预设、角色卡、人设、世界书、Skill。显示是正文上屏时经过的正则、折叠和按钮。本篇还记录第三方来源与署名。

## 谁决定什么

| 资料 | 决定 |
| --- | --- |
| 用户启用的预设 | 写法：文风、视角、长度、人物表达 |
| 角色卡 + 世界书 | 设定，以及标签、面板、HTML、选项等展示需求 |
| 系统 Skill（`skills/*/SKILL.md`） | 职责：岗位、工具、阶段与交付协议 |

- 预设保持用户原文和原装配语义，Skill 不借流程规则改写预设，也不另加文风黑名单。
- 显示正则不是生成要求；关闭的模块不会因皮肤正则或关键词还在而重新启用。
- 外部插件的强制协议与梨园实际支持的能力分开处理；采样参数走参数，不再写一遍提示词。

## 世界书

管理面板、程序卡、原插件和实际生成共用 `src/worldbook-bindings.ts` 的来源解析。

- **主书**：按卡的 `data.extensions.world` 精确匹配库内独立书（书名、文件名或已知路径），找不到才用卡内 `character_book`。同名歧义报错，不按标题猜。面板展示实际主书，内嵌副本标明是否参与生成。
- **作用域**：附加书可以挂到本角色（默认，换卡不带走）、当前聊天（按 session+卡）或全局；agent 补充按卡加载。旧 `lorebooks`/`lorebook` 挂载保持全局并标注。同一本书重复绑定只装一次；不同书即使条目相同也各自启停。
- **灯色**：绿灯常驻、蓝灯关键词、灰灯停用。实际送模先过滤停用项再裁剪；管理和原生上下文保留原始空行与停用行。
- **写入**：明确 `source=card|file|agent`，卡和补充绑定当前卡身份，重复正文用原始行键区分；保留未知字段，批量写入先校验全部目标、二次确认、失败回滚；卡内保存原子替换，保留权限、软链接、立绘和 ccv3/chara 双字段。切卡或版本过期的请求拒绝。启停写原生 `enabled/disable`。
- **程序卡接口** `getCharWorldbookNames/getWorldbook/replaceWorldbook` 与生成用同一份来源清单；`replaceWorldbook` 只兼容已读条目的启停，不改正文、不增删条目，过期就报错让用户重读。
- 新建独立卡位复制当前卡的主书、附加书和原全局书，不继承其它卡的绑定。
- 修正绑定只影响之后的输入，不自动清除已保存的生态人物或侧写；既有污染要按来源审计后单独修正。

## Skill

内置 Skill 在 `skills/*/SKILL.md`，随版本更新；用户私人覆盖在 `.liyuan-stage-skills/`（不公开），由 `src/stage/skill-store.ts` 管理。

- 私人覆盖优先于同名内置 Skill；升级只更新内置版本，不动私人覆盖。删除覆盖后重新露出当前内置版本。
- 覆盖记录它基于的内置版本指纹；普通保存不推进这个基线，不冒称已审阅新内置版本。
- `主演文本直出` 是普通文本通道协议。`卡格式需求识别`、`卡格式完整交付`、`主作者正文边界` 只为兼容保留，两种模式都不自动执行。

## 显示

显示层从完整 `rpAuthorDraft` 出发，经原作者正则和既有安全策略（思考折叠、HTML 沙箱）上屏。规则顺序为预设 → 挂载世界书 → 角色卡，与 `cardfront` 共用绑定清单。所有处理只作用于显示副本，不回写原稿、事实或旧存档。

- **`rule_check` 与正文是独立作用域**：检查块只接受自己的整块规则一次，捕获文字转义后交给原检查面板；其中的示例标签不打开故事标签、不触发对白规则、不生成嵌套整页 HTML。原卡有 renderer 就渲染原检查面板，没有就放进思维折叠。
- **受保护片段**（对白、心声等嵌套 HTML）按父到子、索引降序还原（`applyCardSkinProtected`），内部占位符不会变成可见文字。
- **行动选项**保留严格的 `<options>` 范围，在作者正则之后处理，到 React 才转按钮。
- **流式增量**只作临时显示；成功终态用完整终态文本校正原稿。失败或取消保留已有半稿，迟到的终态不覆盖。
- **"正则与渲染"查看器**只读：展示规则来源、顺序、开关、用途、深度条件、表达式、替换串和跳过原因，可载入当前原稿或合成文本预览。预览在可终止的 Worker 中运行，超时即停；HTML 预览是静态沙箱，不执行卡脚本。

改显示要在桌面和手机上实际展开、收起原面板，核对完整文本、字面标签和源码尾巴。

排查"显示少了东西"：先比对完整 `rpAuthorDraft` 与显示，分清是作者没写还是显示丢了；再用查看器看规则来源和跳过原因。变量没更新看 MVU 收据，附属补交完成不代表 MVU 完成。

## 来源与署名

### Luker 导演提示词（AGPL-3.0-only）

七份 `skills/导演*/SKILL.md`（导演证据整理、导演设定核对、导演生态参考、导演角度构思、导演事实审阅、导演预设审阅、导演主Agent）对照、翻译并适配 Luker Team 的 v2.8.0 提示词与方法 Skill。来源仓库 `github.com/funnycups/Luker`，参考 commit `e25115a572b9c3a85af5a3a29b9098f9b46d80c7`。

| 梨园 Skill | Luker 来源 |
| --- | --- |
| 导演证据整理 | `chat-scout-method-zh` |
| 导演设定核对 | `intent-scout-method-zh`、`lorebook-scout-method-zh`、`epistemic-scout-method-zh` |
| 导演生态参考 | `notes-pickup-scout-method-zh` 的相关性筛选，结合梨园生态与世界材料 |
| 导演角度构思 | `plot-brainstormer-method-zh` |
| 导演事实审阅 | `continuity-critic-method-zh` |
| 导演预设审阅 | `voice-critic-method-zh` 的用法判断、人物表达与框架泄漏检查；尺度改为用户预设与人设 |
| 导演主Agent | `director-turn-workflow-zh`、`notes-curator-method-zh`；`public/scripts/extensions/orchestrator/director-default-prompt.js` |

方法 Skill 均位于上游 `default/skills/global/<名称>/SKILL.md`；角色边界另对照 `public/scripts/extensions/orchestrator/director-defaults.js`。

- 这七份 Skill 保留 frontmatter 中的 `upstream-author: Luker Team` 与 `license: AGPL-3.0-only`。许可原文见 `licenses/Luker-AGPL-3.0.txt`（[Luker AGPLv3](../licenses/Luker-AGPL-3.0.txt)），组件声明见 `licenses/README.md`（[许可说明](../licenses/README.md)）。新增适配不抹去来源。
- 主项目 [LICENSE](../LICENSE) 为 PolyForm Noncommercial 1.0.0，不覆盖这些 AGPL 组件；两者组合的兼容性与再分发、网络服务义务须在发布前独立审查。

适配方式：保留阶段隔离、同阶段并行、唯一正文作者、默认信任草稿；把 Luker 的动态专家集合收敛为固定 3/2/2；改用梨园的记忆、原卡、人设、世界、生态、导演室与研究；普通文本写作，工具名适配梨园阶段收据与 `finalize`；报告用带来源 id 的 JSON；只传短报告和检索回执，不传主 Agent 完整 reasoning；不继承通用禁词表或固定文风。

### 其它来源

| 来源 | 关系 | 落点 |
| --- | --- | --- |
| Luker 请求观测 | 思路参考；载荷存储独立实现 | [diagnostics](diagnostics.md#请求查看器) |
| [ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal) | 思路参考：历法、月历、周期、时间跳转 | 世界/生态 |
| [world-backstage](https://github.com/h675786161-prog/world-backstage)（MIT） | 思路参考：冻结认知、通讯送达、公开传播、事件终态；独立实现，若复制实质代码须保留原版权与许可 | 生态 |
| [OpenViking](https://github.com/volcengine/OpenViking) | 思路参考：分层预算、召回分档、去重、审计 | 旧记忆 |
| [蚀心入魔·数据库](https://github.com/AlbusKen/shujuku) | 旧记忆借鉴其账本纪律；启用原数据库时**实际运行**私有缓存的原安装产物 | [memory](memory.md) |
| [st-fish-audio](https://github.com/severian-dev/st-fish-audio) / [st-fish-audio-plugin](https://github.com/severian-dev/st-fish-audio-plugin)（MIT） | **实际复用**：`packages/fish-audio/upstream/` 保留原字节，commit 与 SHA-256 在 `SOURCE.json`，许可在 `packages/fish-audio/LICENSE` | 配音 |
| 酒馆助手/模板、MVU、Veridis | **实际运行**原插件，固定来源与 hash，各自许可单独遵守 | [plugins](plugins.md) |

思路参考与实际复用分开写；实际复用的保留原版权、许可与固定来源。世界/生态没有复制 SillyTavern/Luker 的故事状态仓或世界钟。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `src/preset*.ts` / `src/stage/materials.ts` / `assemble.ts` | 预设与资料装配 |
| `src/worldbook-bindings.ts` / `src/lorebook.ts` | 世界书来源解析与条目 |
| `src/stage/skill-store.ts` | 内置 Skill 与私人覆盖 |
| `src/cardfront.ts` / `src/cardSkin.ts` / `src/postprocess.ts` / `src/regex-options.ts` | 正则管线、片段保护、`<options>` |
| `src/regex-inspector.ts` / `src/regex-preview.ts` / `web/src/components/RegexPreviewPanel.tsx` | 正则查看器与预览 |
| `licenses/` | 组件许可 |
