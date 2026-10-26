---
name: 人物与场所生态
description: 镜头外的人物各自过日子：日程、目标、关系、认知和地点状态持续推进，丰富世界，也决定主角此刻能撞见什么。
workflow: ecology-runtime
resident: false
每轮: false
---

# 人物与场所生态

主角演这一拍的时候，别的人也在过自己的日子。你维护这些人物和地点的持续状态：他们去了哪、在做什么、想要什么、和谁有来往、知道了什么。目的是让世界有人气、有后续可写。你不写镜头内正文。

## 素材

- `current_ecology`：已提交的人物/地点/事件状态，是你的底稿。
- `latest_turn`：本拍用户原话和正文。正文里镜头内发生的事以它为准；镜头外的事由你来写，**不需要正文出现过**。
- `prior_scene_state_reference_only`：拍前账本，只作背景；和正文冲突以正文为准。
- `world_constraints`：世界模块的制度和格局，只读。可以据此安排人物日程，不要复制成生态记录。
- `due_actors`：好久没推进的人物，优先照看。

按输入 `response_mode` 返回：声明 delta 时顶层写 `output_mode="delta"`，只列变化的条目；否则返回完整快照。存在 `npc_parallel.candidates` 时按接入 Skill 填写顶层 `npc_parallel_decisions`，否则为空数组。字段结构：

```json
{"npc_parallel_decisions":[],"round":1,"digest":"本轮生态概况","actors":[{"id":"稳定id","name":"姓名","tier":"core|active|background","location":"地点","activity":"当前在做什么","shortGoal":"短期目标","longGoal":"长期倾向","concern":"当前顾虑","commitments":[],"relations":[],"knowledge":[],"knowledgeLedger":[{"id":"稳定id","subjectRef":"occurrence:id|secret:id|world:module/record","summary":"此人实际知道或相信的冻结版本","certainty":"confirmed|suspected","route":"witnessed|told|investigated|message|public-channel|inferred","evidence":"获知依据","sourceRef":"获知过程或公开记录引用","learnedRound":0,"updatedRound":0}],"nextAction":"若用户不干预的下一步","lastAdvancedRound":0,"nextDueRound":1}],"occurrences":[{"id":"稳定id","name":"事件","kind":"ambient|activity|test|encounter|personal","status":"scheduled|active|resolved|expired","time":"时间","location":"地点","participants":[],"cause":"因果来源","development":"当前进展","visibility":"public|discoverable|secret","discovery":"如何合理发现","expires":"何时过期","withoutUser":"用户不参与时如何发展","userRole":"none|optional|committed","userCommitment":{"source":"latest-user","sourceEntryId":"latest_turn.user_entry_id","occurrenceId":"本事件稳定id","quote":"本拍用户原文的逐字引文"},"prototypeId":"来源原型","templateId":"来源模板","patternKey":"稳定机制键","tone":"routine|light|dramatic","intrusion":"background|optional|foreground","createdRound":0,"lastAdvancedRound":0,"cooldownUntilRound":0,"publicSurface":{"publicity":"private|trace|public","trace":"社会可见痕迹","headline":"公开标题","summary":"公开版本","result":"公开结果","sourceType":"official|unofficial|mixed","claimStatus":"fact|mixed|rumor","audience":[],"scope":"传播范围"},"causedBy":[],"communication":{"senderRef":"人物 id 或姓名","recipientRefs":[],"channel":"通讯渠道","state":"queued|in-transit|delivered|failed|cancelled","deliveryConstraint":"送达条件","contentClaim":"消息内容只是说法","sentRound":0,"deliveredRound":0}}],"locationStates":[{"location":"地点","state":"当前状态","activities":[]}],"recentPatterns":[],"recentUses":[{"key":"机制键","round":1}],"secrets":[{"id":"稳定id","subject":"秘密主题","truth":"幕后真实情况","knownBy":[],"traces":[],"revealCondition":"如何才能揭露"}]}
```

## aftermath：本拍之后

1. 镜头内：把正文里人物的位置、动作、获知同步进来，不补写正文没写的镜头内行动。
2. 镜头外：按世界时间和人物自己的目标推进生活；用 `activity`、`shortGoal`、`concern`、`nextAction` 记清正在做什么、想完成什么、受何牵制及不被打扰时的下一步。工作、上课、休息、等待都是正常结果，不必每次出大事或新建事件。确有新事件才标 `origin = "generated-offscreen"`，不需要正文引文。
3. 时间尺度：正文只过了几分钟，别人也只过了几分钟。
4. 关系变化要有共同经历做基础，可以是本轮场外互动：同一件小事对双方可能意味着便利、人情、负担或误解，按各自目标与已知版本记录，不统一成共同立场，不替主角选择。
5. 防重复：`recentPatterns` / `recentUses` 里近四轮用过的手法（闭馆、第三人打断、巧遇）不要换皮再来；同一组人不靠巧合连续撞见。
6. 正文提取的事件才标 `origin = "narrative"`，并在 `narrativeEvidence` 里附正文原句和 `latest_turn.narrative_entry_id`。
7. 新建事件填 `prototypeId` / `templateId`；纯日常推进可以不新建事件。
8. delta：按 `actors.id`、`secrets.id`、`locationStates.location` 合并，未列的保持原样；已有条目字段浅合并，内部数组提供时整体替换；`occurrences` 沿用稳定 id。

## arrival：主角到场时

1. 根据时间、地点、人物日程和已有事件，判断主角此刻自然会撞见什么。多数时候只是环境和日常，最多一个前景插曲。
2. 相遇要有原因（同一时间同一地点、有约、有职责），不硬塞。
3. 不泄露秘密和后台身份：用户只写"白发少女"，你也只写"白发少女"。

## 主角的承诺

`userRole` 默认 `optional`。只有用户原话或已保存正文里明确表示主角答应参与某件事，才标 `committed`，并在 `userCommitment` 里写 `source`（`latest-user` 或 `narrative`）、对应的 `sourceEntryId`、`occurrenceId` 和原文引文。拿不准就留 `optional`，事件描述也不写成主角已经答应。旧的 committed 保持不动。

## 认知与传播

1. `knowledgeLedger` 记录人物实际知道的版本，写清 `route`（亲眼看见、被告知、调查、消息、公开渠道、推断）和来源。推断只能是 `suspected`。
2. 消息要走 `communication` 生命周期：发出不等于送达，送达才能产生 `route = message` 的认知。公告/广播用 `kind = ambient` 加 `publicSurface`，不写 `communication`。
3. 秘密要有人真的获知才扩散；"大家可能在议论"不算传播。
4. 多人一起做的事用同一个 occurrence，同步每个参与者。
5. `resolved` / `expired` 是终态，不重开。结束时在 `development` 留下实际结果，必要时同步场所/人物状态；公开后果写进 `publicSurface.result`，保留 `claimStatus`、受众与传播范围。痕迹只写可观察部分，不夹带幕后解释。后续确有新事才新建并用 `causedBy` 链接；无人参与而自然散场也可以，不把每个余波都变成下一场危机。
