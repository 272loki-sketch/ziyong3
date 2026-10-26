---
name: 拍后事实信封
description: 从本拍用户原话和正文里摘出已经发生的事和经过的时间，交给世界推演参考。只摘录，不推演。
workflow: world-facts
resident: false
每轮: false
---

# 拍后事实信封

把本拍镜头里**已经发生**的事摘出来，给世界推演做参考。世界推演会自己写别处的发展，你不用替它想。摘得少没关系，摘错了才有问题。

## 输入

- `latest_user`：用户这一拍的原话。
- `frozen_narrative`：本拍已保存的正文。它和拍前账本冲突时，以正文为准。
- 其余（账本、旧世界、历史）只是背景。

## 规则

1. 只摘已经发生的。愿望、打算、猜测、"明天见"写成 plan / intent / hypothesis，不放进 `triggerFactIds`。
2. 主角的自愿行动，只有用户原话明确说做了，才标 `agency: user-voluntary`，并引用 `latest-user` 证据。正文里写的主角动作标 `other`。
3. 角色台词默认是 `reported`（有人这么说），除非正文同时写明这件事真的发生了。
4. 秘密的事标 `secret`；没人看见的不标 `public`。
5. 经过时间拿不准就写 `unknown`；几句对话是 `moment` 或 `minute`；只有正文写了转场（"第二天早上"）才算过了一天。
6. 证据的 `quote` 从对应原文里**原样复制一小段**（一句话以内最稳），不要改字、不要拼接、不要加省略号。

## 输出

只返回一个 JSON 对象：

```json
{
  "evidence": [{"id":"ev_1","source":"latest-user|narrative|rp-state|prior-world|recent-history","locator":"位置或字段路径","quote":"原文中的一小段"}],
  "facts": [{"id":"fact_1","kind":"action|event|state|knowledge|claim|trace|time-marker|milestone","subject":"主体","predicate":"发生了什么","actuality":"established|reported|intent|plan|hypothesis","visibility":"public|limited|secret","agency":"user-voluntary|user-involuntary|other|none","evidenceIds":["ev_1"]}],
  "elapsed":{"kind":"none|bounded|unknown","unit":"moment|minute|hour|day|week|scene|strategic-turn","min":0,"max":0,"evidenceIds":[]},
  "triggerFactIds":["已经发生、外界可能注意到的事实"],
  "uncertainties":["拿不准的地方"]
}
```

没有可摘的事实就返回空的 `facts` 和 `triggerFactIds`。
