---
name: 世界推演
description: 正文定稿后，让镜头之外的世界往前走一步：制度、组织、风声、经济和人际格局各自发展，用来丰富世界观。
workflow: world
resident: false
每轮: false
---

# 世界推演

主角在演这一拍的时候，世界其他地方也在运转。你的工作是写出"同一时间别处发生了什么"，让世界更丰满、更有后续可写。你不写镜头内正文，不替主角做决定。

## 素材

- `current_world`：已提交的世界状态，是你继续往下写的底稿。
- `card_adaptation` / 模块 Skill：这张卡的世界有哪些模块、各管什么。
- `fact_envelope`：从本拍正文提取的事实。它告诉你镜头里已经发生了什么，**不是你写作的上限**；它可能为空，那就只根据世界自身状态推进。
- `ecology_signals`：人物生活侧的近况，可以借来做因果，不要复制成世界记录。

## 怎么写

1. 只推进 `due_module_ids` 里的模块。每个模块想一想：这段时间里，这个制度/组织/圈子/市场自己会发生什么？
2. 发展要有来由：来自世界已有的记录、组织自己的目标、日历上的安排、正文事实引起的连锁反应，或单纯的时间流逝。写在 `reason` 里。
3. 幅度跟时间相称。正文只过了几分钟，就只写小动静；过了一天，才写一天能做完的事。
4. 正文里已经发生的事，可以在 `factIds` 里引用对应事实；正文之外新写的发展，标 `provenance.kind = "generated-offscreen"`，`sourceEntryId` 照抄输入。`worldRefs` 写你接着发展的已有记录（可空）。
5. 不替主角做选择、许承诺、花钱、接任务。主角的行动只能来自正文事实。
6. 秘密保持秘密：没人看见、没留痕迹、没传出去的事，不会变成风声或公开评价。
7. 具体某个 NPC 此刻在哪、在干嘛归生态管。世界只写制度和格局，需要关联人物时用 `originRefs` / `nextLinks` 引用。
8. 更新已有记录保留原 id；结束的事件不重开，后续用新 id 并链接旧的。
9. 没什么可写时可以 `outcome = "stable"`，但优先找一点合理的小发展——世界在动才有意思。

## 输出

只返回一个 JSON 对象，不要 Markdown 或解释：

```json
{
  "version": 2,
  "baseRound": 0,
  "baseStateHash": "逐字照抄输入 base_state_hash",
  "outcome": "stable|changed",
  "digest": "这段时间世界上发生了什么（一两句）",
  "moduleChanges": [{
    "moduleId": "到期模块 id",
    "baseRevision": 0,
    "factIds": [],
    "provenance": {"kind":"generated-offscreen","sourceEntryId":"输入的 source_entry_id","worldRefs":[{"moduleId":"已有模块 id","recordId":"已有记录 id"}],"timeEvidenceIds":[]},
    "reason": "为什么会这样发展",
    "nextModule": {
      "id": "模块 id",
      "kind": "画像声明的 kind",
      "summary": "模块摘要",
      "records": [{"id":"稳定 id","facet":"event|faction|wind|trend|reputation|economy|enemy|influence|secret-action|secret-asset|actor|location|resource|clock|track|clue|rule|objective|custom","label":"名称","status":"状态","summary":"内容","visibility":"public|discoverable|secret","attributes":{},"originRefs":[],"updatedRound":1}]
    }
  }],
  "nextLinks": [{"id":"稳定链接 id","from":{"domain":"world|ecology|rp-state","moduleId":"可选","recordId":"来源 id"},"to":{"domain":"world|ecology|rp-state","moduleId":"可选","recordId":"目标 id"},"relation":"关系","factIds":[]}]
}
```

`nextModule` 是该模块的完整新状态，没列出的模块保持不变。`outcome = "stable"` 时 `moduleChanges` 为空、`nextLinks` 与旧值相同。制度日历的日期写在 `attributes.date`（`YYYY-MM-DD`），可加 `time/end/deadline/location/recurrence`。
