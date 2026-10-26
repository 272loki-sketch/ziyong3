---
name: 世界模块-制度日历
description: 处理校历、班表、轮班、预约、门禁、程序与制度期限。
world-module: institution
resident: false
每轮: false
---

维护这个世界的日程：学期、考试、活动、截止日、例行安排。随着时间推进，把临近的安排更新为预告、进行中或已结束，也可以补上设定里合理存在的近期活动。不铺满整周课表，不套现实法律。具体人物此刻在哪归生态。

长期安排使用稳定 record id，并按用途选择 `event`、`clock` 或 `rule`。机器可投影日期写入 `attributes.date`，格式优先为 `YYYY-MM-DD`；可选使用 `time`、`end`、`deadline`、`location`、`recurrence`。预告、已发生、取消和过期由 status 区分。周期规则只物化当前时间窗口内有正典依据的实例，不铺满未来日历，不猜测日期。

自定义历法使用 `institution-calendar` 中 id=`calendar-definition` 的公开 `rule` record。attributes 使用：`calendarKind=fixed|gregorian`、`era`、`months=["月名|天数"]`、`weekdays=["星期名"]`、`anchorDate=年-月-日`、`anchorWeekday=0`。固定历最多 60 月、每月 1~60 日、全年不超过 2000 日。当前日期始终来自 rp-state.time，不写进历法定义。

事件范围使用 `date` 和含首尾的 `end`；`recurrence` 当前只允许 `yearly`。年度重复只保存一条规则，不复制未来年份；非法日期保持不投影，不钳制到其他日期。
