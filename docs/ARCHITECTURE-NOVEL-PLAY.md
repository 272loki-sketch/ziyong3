# 小说开演架构补充

本文补充 `docs/ARCHITECTURE-OVERVIEW.md` 中的小说开演路径。它不创建第二套 Writer、Session Tree 或事实状态。

## 数据路径

```text
CorpusEngine
  -> NovelSource / exact evidence
  -> NovelPackage immutable revision
  -> opening proposal (unconfirmed)
  -> user confirmation
  -> internal Character Card V2
  -> existing switchToCard()
  -> existing Session Tree + StageEngine
```

## 模块边界

| 模块 | 责任 |
|---|---|
| `src/novel-play/source.ts` | 从现有 CorpusEngine 分块建立内容指纹和精确原文区间。 |
| `src/novel-play/extract.ts` | 读取 Skill，严格解析事件，校验块内依赖和原文引句，支持空块和检查点。 |
| `src/novel-play/store.ts` | 保存不可变作品包和版本，拒绝路径穿越及版本不一致。 |
| `src/novel-play/opening.ts` | 只把开演锚点允许的原文范围交给开场模型，生成待确认提案。 |
| `src/novel-play/card.ts` | 使用现有角色卡 V2 结构生成内部卡。原始扩展保存作品版本、锚点和玩家身份。 |
| `src/novel-play/application.ts` | 复用现有 Skill、旁路模型、配置和切卡能力，管理构建、预览和开演事务。 |
| `server/novel-play-api.ts` | 在现有认证 REST 路径内提供构建、状态、预览和开始接口。 |
| `src/novel-play/runtime.ts` | 从当前分支祖先链生成候选，并校验冲突来源、版本和当前进度。 |
| `src/stage/engine.ts` | 将有效候选交给已有剧情适配与导演路径，不把候选写成事实。 |
| `web/src/planning/novel-play.tsx` | 在导演室提供构建、起点、身份、预览和确认交互。 |

## 权威规则

1. Session Tree 是聊天、分支、回复和已发生剧情的权威。
2. `rp-state`、世界状态和生态状态继续使用原有权威，不由小说开演复制。
3. 原著节点只能作为候选。当前分支已确认事实优先。
4. `rp-novel-play` 只保存作品版本、进度和经过来源校验的冲突元数据。
5. 回档只读取当前祖先链，不能读取兄弟分支的小说开演状态。
6. 重 Roll 复用既有拍前结果，不重新写小说进度。
7. 所有模型提示词继续放在 Skill，TypeScript 只做编排、解析和安全门禁。

## 安全边界

- 作品包原文不会全量发送给主演。
- 开场模型只收到锚点允许的连续原文范围。
- 公开候选不携带秘密节点、源文本或完整角色卡。
- 构建、预览和开始均绑定当前会话与角色卡。
- 一次性预览令牌、限流、超时、取消和切卡恢复锁防止重复或过期操作。
- 切卡超时时不假定底层操作已取消。系统保留恢复信息并阻止破坏性并发操作。

## 验证与诊断

`npm run test:novel-play` 覆盖合成来源、引文定位、作品包版本、开演确认/事务、运行候选和分支隔离；命令要求见 [TESTING](../TESTING.md)。真实模型、浏览器游玩、长篇剧情质量及不同桌面系统需独立验收，不用历史测试总数代替当前结果。

资料缺失时先核对 Corpus ready、源块和作品包 revision；提案不能确认时核对当前卡/会话、锚点范围及令牌是否过期；切卡超时先查恢复状态，不盲目再次开始。具体维护步骤见 [NOVEL-PLAY-MAINTENANCE](NOVEL-PLAY-MAINTENANCE.md)。
