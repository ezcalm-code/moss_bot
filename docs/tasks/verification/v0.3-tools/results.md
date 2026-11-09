# v0.3 工具框架（web_search 联网搜索）验证记录

日期：2026-11-09 · 分支 main · 前置：`scripts/probe-gateway-tools.mjs` 4/4 PASS（内部 OpenAI 兼容网关 tools 透传）

## 单测（npm test，150 全绿，含新增 ~40 用例）

| 标准 | 用例（文件） | 结果 |
|---|---|---|
| tool_call 增量分片重组、事件顺序、finish 缺省、id 回退 | openai-compat.test.ts 10 用例 | PASS |
| Tavily 请求体/映射/错误/空结果 | tavily.test.ts 4 用例 | PASS |
| 冷却命中/恢复/失败烧窗/参数错/chatId 隔离 | tools/web-search/index.test.ts 7 用例（假时钟） | PASS |
| ToolRunner 永不 throw（未知工具/非法 JSON/抛错/截断） | tools/index.test.ts 6 用例 | PASS |
| tools 段默认值/部分配置/缺 provider/缺 key 报错/supportsTools 透传 | config/schema.test.ts 5 新用例 | PASS |
| 循环多轮/3 轮上限/空 calls 防死循环/首轮 4xx 降级/后续轮 4xx 不降级/静态关/带图不挂/冷却贯穿/记忆提取照常 | core/bot.test.ts 10 新用例 | PASS |

红灯验证：tavily.ts 的 `await opts.fetch ? :` 优先级 bug 由 tavily.test.ts 首轮全红抓出（res.text is not a function），修复后转绿；bot.ts 降级分支首版 `consumeRound` 作用域错误由「首轮 4xx 降级」用例抓出，修复后转绿。

## REPL 真机实测（内部 OpenAI 兼容网关默认模型，2026-11-09）

| 场景 | 输入 | 实际结果 |
|---|---|---|
| 闲聊不触发搜索 | 「你好呀」 | 正常闲聊回复，无 LLM 搜索调用 |
| 时效问题触发搜索（占位 key，预期失败兜底） | 「今天比特币价格多少？」 | 模型发起 web_search（query=比特币价格 今日 实时行情）→ Tavily 401 → 模型自然措辞告知搜索不可用，进程与历史正常 |
| 冷却拦截 | 紧接「再帮我搜一下今天的新闻」 | 工具返回冷却说明，模型转述「搜索还在冷却中……再等四五分钟」，Tavily 未被调用 |

## 真机追踪：日期错答与时效混杂（2026-11-09）

| 现象 | 排查 | 修复 | 验证 |
|---|---|---|---|
| 「今天谁赢了」答成 11月6号内容 | 日志：搜索正常（5条），根因是 system prompt 无日期，模型无时间感知 | system prompt 注入当天日期+星期（25e4d31） | REPL「今天几号」答对 2026-11-09 周一 |
| 「下一场」答等 IG vs Gen.G（IG 已淘汰） | Tavily 结果时效混杂（赛前前瞻 SEO 排前）+ 结果未带发布日期，模型无法分辨新旧 | published_date 透传并标注（b7c946d） | **实测 Tavily 基础搜索多数结果不返回该字段**（news 类才稳定），日期标注为尽力而为；时效分辨主要靠 system prompt 日期锚定 + 结果正文中的日期 |
| 回归验证 | 同日 REPL「下一场比赛」：回答正确区分今天/昨天赛程，并对开赛时间主动说明不确定性；同轮第二次搜索被冷却正确拦截 | — | PASS |

## 三项改进（2026-11-09，c9b25ea，163 测试全绿）

| 项 | 改动 | 单测 | REPL 实测 |
|---|---|---|---|
| 飞书流式卡片修复 | sequence 起始 1（官方文档确认 0 触发 300317） | stream.test.ts：首更=1、严格递增、定稿/abort 续号（300317 回归用例） | 待真机 |
| 群聊消息排队 | bot.ts per-chat 串行化，深度≥5 丢弃+日志 | 同 chat 串行/跨 chat 并行/超限丢弃/队清空回收 4 用例 | 待真机 |
| read_url 读链接 | Tavily Extract + PageExtractor 可插拔，无冷却 | tavily extract 3 用例 + 工具层 4 用例 + bot 循环 1 用例 | PASS：example.com 链接 → 模型调用 → 156 字符正文被抓取并准确总结 |

## 待补（真机验收清单，用户配合）

- [ ] 飞书私聊+群聊流式打字机正常、日志零「卡片更新失败」warn
- [ ] TG 群聊超长回复分段正常（AC3.3 补测）
- [ ] 同群连发 6+ 条消息，第 6 条起丢弃且无并发交错
- [ ] 发新闻链接问内容 → read_url 读全文回答
