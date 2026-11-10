# v0.5 每日播报 + 群投票 + 加密笔记 + 时区基建 验证记录

日期：2026-11-10 · 197 测试全绿（新增 ~15 用例）

## 单测覆盖

| 块 | 用例 | 结果 |
|---|---|---|
| 时区 | zonedNow 多时区分量、跨日时刻、nextOccurrenceAt 今天/明天、dayStringInTz 跨日差异、非法时区拒绝 | PASS |
| 提醒解析改造 | HH:MM/完整日期在 tz 下解析（存量用例全绿无回归） | PASS |
| 笔记 | 密文落盘（明文零命中）、roundtrip、错 key 解密抛错、按用户隔离、跨用户不可删、空内容拒绝、工具两条 | PASS |
| 播报 | 时间校验与零填充、到点触发+当日去重、未到点不触发、生成失败推失败说明且当日不再重试、chatId 隔离与取消 | PASS |
| 投票 | service 计票（单测在 service.test）；卡片按钮 JSON 构造（真机验证按钮回调形状） | PASS |

## REPL 实测（2026-11-10）

| 场景 | 结果 |
|---|---|
| 自然语言记笔记（「帮我记个笔记：书房 wifi 密码…」）→ /notes 列出 | PASS：add_note 工具调用、加密存储、列表可见 |
| 密文落盘 | PASS：notes.bin 为 {iv,tag,data} 结构，明文「moss2026」零命中 |
| /broadcast 设每日播报 → 到点触发 | PASS：lastFiredDay 当日标记、去重生效、生成+派发链路走通（REPL stdout 竞态致打印不可见，生产走平台适配器无此路径） |
| /poll 在 REPL（无投票平台） | PASS：正确提示「投票功能未装配」 |
| timezone 注入 | PASS：config timezone: Asia/Shanghai，时间注入与提醒解析走 zoned 工具（单测锁死） |

## 待补（真机，用户配合）

- [ ] TG /poll 发起投票 → TG 原生投票卡片正常
- [ ] 飞书 /poll 发起投票卡片 → **先在开发者后台「事件与回调」开启卡片回调订阅（长连接方式）** → 点按钮 → toast 显示票数
- [ ] TG/飞书各设一条次日播报 → 次日到点收推送摘要
