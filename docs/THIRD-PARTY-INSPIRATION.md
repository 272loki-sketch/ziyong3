# 第三方能力参考

梨园的鲜活世界与日历能力参考过以下开源项目的产品思路，并按梨园权威边界独立实现：

- [ST-SevenDaysCal](https://github.com/atonal519/ST-SevenDaysCal)：自定义历法、月历、多日日期、周期追踪与显式时间跳转交互。
- [world-backstage](https://github.com/h675786161-prog/world-backstage)：人物冻结认知、通讯送达、公开传播面、后台人物饥饿保护与事件终态。
- [蚀心入魔·数据库](https://github.com/AlbusKen/shujuku)：酒馆的“表 + 世界书”记忆插件，提供逐轮纪要、稳定 AM 索引、合并阈值和概览列。旧记忆回退借鉴其账本纪律与列式元数据过滤，使用 agent 原生事件卡；启用原数据库时则实际运行私有缓存的原安装产物、填表/召回与世界书投送。两条路径不能混称为纯思想参考，详见 [DATABASE-PLUGIN](DATABASE-PLUGIN.md)。
- [OpenViking](https://github.com/volcengine/OpenViking)：agent 上下文数据库——L0/L1/L2 三层预算（摘要 ≤256 字 / 概览 ≤4000 字 / 详情按需）、意图分析 TypedQuery 分档、向量预筛 + LLM 语义去重、memory_diff 审计。梨园吸收其分层预算、召回分档、去重 decision 链（skip/create/merge/delete）和审计思想，不引入 AGFS/VLM/Python 服务端或 PPR 图遍历。

世界/生态没有复制 SillyTavern/Luker 的独立故事状态仓或世界钟。酒馆插件宿主另有 DOM、事件、变量与 prompt depth 兼容实现，导演 Skill 也有 Luker 的实质提示词适配，不能将这些全部称为仅产品思路参考。梨园继续坚持：

- 当前时间与镜头账本进入 `rp-state`；
- 宏观制度和历法进入 `rp-world-state`；
- 人物生活、通讯和具体事件进入 `rp-ecology-state`；
- 日历、舆情和认知展示为只读投影；
- 所有状态随 Session Tree 分支、回档和变体恢复。

`world-backstage` 仓库使用 MIT License；若后续直接复制其实质代码，应保留原版权与许可证。当前整合为依据公开行为重新实现。

Luker 提示词的固定来源、署名和 AGPL-3.0-only 许可声明见 [PROMPT-SOURCES](PROMPT-SOURCES.md)。原酒馆插件、MVU、NPC 与 Veridis 的来源/安装边界分别见 [TAVERN-PLUGINS](TAVERN-PLUGINS.md)、[MVU](MVU.md)、[NPC-PARALLEL](NPC-PARALLEL.md)、[VERIDIS-REWRITE](VERIDIS-REWRITE.md)；原许可和再分发限制不能被梨园许可替代。

权威边界、一拍流程与维护要点以 [架构](ARCHITECTURE-OVERVIEW.md)、[世界](PLAN-WORLD-ENGINE.md)、[生态](PLAN-LIVING-ECOLOGY.md) 为准。
