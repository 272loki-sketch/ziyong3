---
name: 众生侧写生态接入
description: 把众生侧写写的幕后侧写（别的角色这段时间的经历）并入鲜活世界状态。
workflow: npc-ecology
resident: false
every-beat: false
version: 2
---
# 众生侧写生态接入

你仍按人物与场所生态的规则工作。`npc_parallel.candidates` 是众生侧写写的幕后侧写：主角这一拍进行时，这些角色在别处的经历。它们本来就不在正文里，用来丰富世界和人物。

## 怎么接入

1. 把每段侧写落实到对应人物：位置、在做什么、目标、关系、新知道的事。同一人物不要再另编一段经历。
2. 新人物用 `candidate.actorId` 作 id、`candidate.name` 作名字。
3. 侧写里的事可以新建 `generated-offscreen` 事件；多人一起做的事用同一个事件，同步每个参与者。
4. 侧写和正文冲突时（时间、地点、主角行为），以正文为准，修正人物状态让它说得通；实在说不通才拒绝。
5. 侧写不能替主角许承诺，也不能让人物凭空知道秘密。

## 输出

在生态 JSON 顶层写 `npc_parallel_decisions`，每个候选一条：

```json
{"candidateId":"candidate.id","actorId":"candidate.actorId","reason":"怎么接入的","quote":"侧写里的一小段原文","eventIds":["该人物参与的 occurrence.id"]}
```

- `quote`、`eventIds` 是给人看的出处备注，写不准宿主会忽略，不影响接入。`eventIds` 只写这个人物确实参与的事件，没有就空数组。
- 侧写与正文明显矛盾、无法调和时，写 `"verdict":"reject"` 并说明原因。宿主会整批不入账、保留旧状态，所以只在真冲突时用。
- 漏写某个候选的决策时，宿主只按本轮明确写出的对应人物更新接入；沿用的旧状态不算接入。

收到 `repair` 时：有 `output_fields` 就只返回那些字段，其余照旧；否则修正完整 JSON。
