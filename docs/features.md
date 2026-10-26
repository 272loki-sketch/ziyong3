# 外围功能

以下功能都在一拍之外，不参与正文、事实或后台结算。访问保护见[运维](../deploy/VPS-OPERATIONS.md#访问保护)。

## 多卡并行与主窗口接管

主窗口之外可另开独立卡位：**最多同时运行 3 个，保留 12 个**。每个卡位是独立故事，由 `server/play-slots.ts` 启动一份 `server/main.ts`，有自己的工作目录、HOME 和会话树；一拍的规则在卡位内照常执行，队列与收据不跨卡位。

- **新建**：复制所选卡、主窗口当前启用的模型配置和所需资料作为快照，之后双方独立；不复制正文、记忆、数据库或插件缓存。依赖共享 OAuth 刷新令牌的配置、绑定私有原著包的开演卡不能新开。
- **隔离**：子进程只监听回环，浏览器经主服务鉴权的同源网关访问，拿不到子端口、Cookie 或 Token。
- **精简并行台**只显示原稿文本，不执行卡内 HTML/JS，不开放管理和插件设置；完整界面用"主窗口继续"。
- **接管**只改变主服务把完整界面路由到哪个工作区，不导出、不复制、不合并。交接以 workspace + 租约 CAS 为条件，任一边在生成、整理、助手运行或有待受理输入时拒绝。旧页面停止投递并保留编辑框。
- 草稿与投递日志按卡位隔离；带剧情方向的草稿只能在完整主窗口提交。
- **关闭面板不停止生成**。暂停须该卡位空闲并等子进程退出；重启后由用户手动恢复，不自动发输入，不自动删除。
- 产品更新、访问控制和卡位管理属于主服务；故事与资料接口属于被接管的工作区。

`.liyuan/play-slots/`（含 `main-window.json`）是私有持久数据，原路径保留，不当缓存清理。重启前的停机步骤见[运维](../deploy/VPS-OPERATIONS.md#停机前)。

## Fish Audio 配音

插件中心的原生入口：填 Key、给角色绑定音色（名字 + 别名），在已完成的正文下先看不调用 Fish 的识别预览，再"生成并播放"。

- 默认关闭，须显式启用。Key 只存服务端，不回显。
- 说话人只按用户绑定的名字/别名和明确格式（`名：对白`、`【名】对白`、`名说："…"`）识别；歧义、未署名、未绑定的对白和旁白跳过，不用模型猜。
- 收费请求失败不自动重试。兼容网络模式只影响 Fish，仍严格校验 TLS。
- 设置按 source/revision CAS 保存；请求和音频绑定会话/卡/正文来源，切换或取消后的迟到结果不写入。配音不写会话树、记忆、数据库或 MVU。

`.liyuan-fish-tts/` 私有、按工作区隔离，卡位不继承 Key。上游模块原字节复用，见 `packages/fish-audio/SOURCE.json`。更新需配套 `server/fish-tts-*.ts`、`src/fish-tts.ts`、`packages/fish-audio/` 和前端。

## NovelAI 生图

"设置 → NovelAI 生图"开启后，正文里完整的 `<image>`/`<imageTag>`/`image###…###` 原位出现"生成图片"按钮，点击才生成；宿主不改写提示词。

- 默认关闭，旧配置里的 `enabled: true` 不生效。刷新、翻历史、重连都不发请求，没有后台补图或自动重试。
- 请求与缓存绑定会话/卡、来源条目、提示词、参数与接口，切走或取消即丢弃结果；每个工作区串行排队。
- 旧配置、索引与历史图片只读兼容。代理只认显式 `LIYUAN_NOVELAI_PROXY`。

排队间隔、超时与体积上限见 `src/novelai.ts`。

## 背景主题

"设置 → 外观 → 背景选择"提供默认（白瓷朱砂）、护眼（浅绿）、夜晚（暖墨）三套配色，只存浏览器 `localStorage` 的 `liyuan.theme`，不写会话或配置，不改卡自带的 HTML/CSS。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `server/play-slots.ts`、`server/main-workspace.ts`、`web/src/components/PlaySlotsPanel.tsx` | 多卡卡位、接管租约与网关 |
| `src/fish-tts.ts`、`server/fish-tts-*.ts`、`web/src/components/FishTts*.tsx` | 配音 |
| `src/novelai*.ts`、`server/novelai-http.ts`、`src/historical-images.ts` | 生图与历史图片 |
| `web/src/theme.ts`、`ThemeSelector.tsx` | 背景主题 |
