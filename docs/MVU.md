# 原版 MVU 变量系统

MVU 是随原酒馆助手运行的派生变量框架，不是同名垫片、第二正文作者或另一套故事权威。变量和面板不反写 `rpNarrative`、`rpAuthorDraft` 或角色账本。

## 来源与许可

采用 MagicalAstrogy / StageDog **MagVarUpdate v0.193.0**，commit `54be11b09f21b1c4266e2d54b6f1ba9a3598db05` 的原 `artifact/bundle.js`。该安装基线的原 bundle 及 75 项执行依赖固定哈希，不修改 MVU、酒馆助手或模板插件源码。

MVU 的 MIT 许可、artifact 许可说明及 StageDog 桥仓库的 PolyForm Noncommercial 许可分别随安装保留，不能把不同来源笼统宣称为 MIT。原 StageDog `mvu_zod.js` 的固定来源为 commit `b2af181204e70b738132750548930c77c39eff76`。原资产位于私有 `.liyuan-tavern-plugins/mvu/`；不把用户变量、Key 或上游私有安装缓存放进公开仓库和发行包。

常见 CDN/testingcf beta bundle 入口映射到该固定原版，属于固定版本兼容，不声称远端 beta 最新。其它明确版本 URL 不能无验证替换。安装需要明确、已验证的 fixture，不在构建时从浮动地址拉脚本。

## 启用与生命周期

主界面 **酒馆插件 → MVU 变量框架** 提供启用开关、版本校验、当前来源和处理收据。MVU 依赖已安装且已启用的原酒馆助手；助手关闭时不能显示为可用。启停不改原卡、预设、模型分工或剧情记忆。

通过原助手脚本树和原 iframe 运行器加载原 MVU，保留其 `initializeGlobal/waitGlobalInitialized` 及共享接口，不重写事件/解析器，不预造假的 `Mvu.isMvuEnabled` 对象。

拍后 MVU 位于原酒馆插件事件链，与场记、世界、生态、数据库和可选显示润色并发计算，不另起第二次调用或重复原事件。作者有待执行资料写操作时，该插件链在操作完成后启动。宿主并发调度不等于原 MVU 的“额外模型并行解析/非阻塞”已获支持。

只加载卡明确启用的 MVU/schema 依赖，不自动开启脚本库的相册、工坊、论坛等其它自动化。宿主等待声明的 schema 监听器真正注册；没有变量时由原初始化事件触发原 schema 自身默认值，不补造剧情事实。新楼层先继承当前祖先链最近有效变量，确实没有先前数据时才初始化默认值，不因换楼层重置已发生状态，也不读兄弟分支。

## 解析与持久化

支持面包括原 `parseMessage` 的 `_.set/_.add/_.insert` 等命令、JSONPatch 的 replace/delta/add/remove、`getMvuData`、`replaceMvuData`、助手 message 变量 API 和 MVU 更新事件。原 schema、数组可扩展性及命令校验仍由原框架执行，不为测试放开所有变量。

变量经插件派生存储保存并可重新绑定恢复，使用 session/card/source、祖先链、nonce 和 revision/CAS 守卫。flush 不仅等待已排队保存，也保存原助手迟到的变量内存修改；ESM 可变引用和绑定代次仍按 [酒馆插件合同](TAVERN-PLUGINS.md) 处理。

仅在交付含完整有效 JSON 数组、外层 UpdateVariable 已闭合但缺少 `</JSONPatch>` 时，宿主可对**传给 MVU 的解析投影**补该闭合标签。原作者字节、显示与事实不变；无效或半截 JSON 不猜补，不调用模型补格式，也不把变量解析当作者成功门槛。

拍前世界书投送前只调用原 MVU 专属过滤监听器并返回保留索引，不用正则删原文、不改卡/原条目。原助手的 world settings、`world_info.globalSelect`、`loadWorldInfo` 等接口由兼容宿主提供，不意味着运行完整酒馆。

## 独立受管额外解析

原设置的“额外模型解析/自定义”使用独立 `stepModels.mvuParse`，精确绑定已启用连接；失效明确拒绝，不回退正文写手。鉴权由服务端连接提供，不将真实 Key 填入原设置，也不自动迁移或清空已有私人凭据。冲突配置应明确报错，由用户决定如何调整。

支持边界是受信任拍后任务中的单请求、阻塞解析：校验原设置、自定义端点、模型引用、scope/source/nonce 和 internal phase。消息与额外请求仍由原助手和原 bundle 装配；请求为 candidate-only，只更新派生变量。自动/手动入口不同，不能用打开自动请求开关来代替手动重试。

额外解析失败留 pending，不写成功收据；请求消耗助手每 session/card/source 八次持久辅助额度，失败不退款、重启不清零。原并行解析、非阻塞、工具模式、任意自定义连接及 OAuth 并未全部支持或验收。原工具模式得到明确“不支持”能力判断，不向正文 Agent 偷接工具，也不以伪 ToolManager 冒充成功。

## 单独恢复当前回合

`POST /api/mvu/recover` 仅处理当前来源的已存完整作者交付；半稿、用户输入、缺原交付或过期来源拒绝。插件整体未完成也可单独重试 MVU，不重发正文，不重跑数据库/生态，不把其它插件标完成。

- 随 AI 输出模式按 generation started → message received → generation ended 顺序重放捕获的原 MVU 监听器。
- 额外解析模式调用原脚本“重试额外模型解析”按钮的原监听器及 `force:true` 行为，不以自动 MESSAGE_RECEIVED 代替手动按钮，不改自动请求开关。宿主提供 `{{lastMessageId}}`，防止原楼层读取成为 NaN。
- 捕获按原脚本身份隔离；额外请求内部产生的嵌套生成、世界书和展示事件不会重跑模板/其它插件，原 schema 变量事件保留。
- 恢复使用临时 signal、nonce、拍后 phase、scope/source、CAS 和持久额度。初始化前捕获当前来源变量、收据及 `extra_analysis` 基线，中间保存只投影这些基线，成功后发布；失败恢复基线，不回滚整个配置或其它来源。结束关闭临时 realm，阻断迟到任务。
- 完成观测绑定完整交付；初始化事件、继承变量、旧 existing 或未经原事件证明的 unchanged 不能冒充本拍完成。额外模式须有成功 candidate-only 请求和原生命周期结束；缺更新内容明确失败，原合法空 JSONPatch 真正处理完才可记 unchanged。
- 成功收据幂等复用；后续正常插件结算跳过已单独完成的 MVU 监听器，避免重复请求。旧拍缺收据不自动补造历史变量。

## 管理与诊断

管理概览只显示来源、收据、根分组数量和恢复资格，不泄露变量值或正文。**启用是模块开关，不证明本回合变量已处理。** 操作反馈直接出现在面板内，不依赖被弹窗遮住的全局 toast。

“打开原版 MVU 设置”通过原助手的专用 `focus=mvu` 页面加载原 Vue 设置；原接口和真实设置节点均完成才报告就绪，不复制控件或混用助手版本。主题、中文 context 接口和同源 Escape 返回由宿主适配，原词典与代码不改。

“重试本回合变量”携带 `scopeKey/sourceEntryId`，提示独立模型可能收费并消耗额度，显示等待、成功或拒绝原因；重复点击只发一次请求。忙碌、半稿或错误来源显示不能重试的理由。状态读取失败保留旧概览供诊断但禁用写操作，允许重新读取。

切会话/卡/来源取消旧界面等待，旧结果不覆盖新面板；同来源 hello/resync 不吞掉恢复反馈。关闭面板只停止本地等待，**不证明服务端请求撤回**。超时/断流后先刷新核对收据与实际请求，不自动重提。状态、入口/启停、恢复的界面等待上限分别为 15、20、90 秒，不把超时标成功。

只读 `GET /api/tavern-plugins/mvu/view` 返回安装/助手状态、来源、忙碌、恢复资格、根数量和收据，不运行解析器或模型。开关写入在开始及提交前检查忙碌，并等待运行时关闭；若开关已保存但关闭失败，明确报告部分完成，需刷新核对。

## 源码与限制

| 入口 | 责任 |
| --- | --- |
| `server/mvu-assets.ts` / `scripts/install-mvu.mjs` | 固定原资产、依赖、许可与安装校验 |
| `server/mvu-view.ts` | 只读概览及恢复资格 |
| `server/tavern-plugin-http.ts` / `tavern-plugin-runtime.ts` | 受管模型、原运行器、来源与恢复 |
| `web/public/tavern-compat/bridge.js` / `host.js` | 原助手接口、事件与派生存储适配 |
| `web/src/components/MvuPanel.tsx` | 开关、原设置入口与面板内反馈 |

测试命令和 fixture 要求见 [TESTING](../TESTING.md)。合成解析、固定原 bundle/schema、浏览器状态恢复和真实端点请求是不同证据层；任何一项通过都不证明任意卡、复杂第三方 zod 脚本、所有外部依赖或完整酒馆/API 等价。卡缺 initvar/模板/命令或原校验拒绝时，应真实报告，不补造变量来凑成功。
