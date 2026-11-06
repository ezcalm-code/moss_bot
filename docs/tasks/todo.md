# moss-bots 任务清单

## 原始需求（原话，唯一锚点）

> 接入telegram、飞书，帮忙完成一些任务，前期主要做聊天、后期可以执行一些较难的任务，对标grok bot

## 我的理解（与原话并列）

- 核心形态：开源聊天机器人，对标 grok bot（X 平台上 Grok 驱动的回复 bot）
- 平台：Telegram + 飞书，适配器模式，后续可扩展
- 分期：前期只做聊天；「执行较难的任务」（tool use / agent 能力）是后期目标，本期只留扩展点
- 已拍板：TypeScript；LLM 层 OpenAI 兼容、多模型可插拔
- 项目名沿用目录名 moss-bots

计划全文见 [docs/ROADMAP.md](../ROADMAP.md)，架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

## 当前进度

- [x] 需求确认（用户已答：形态 / 技术栈 / LLM 接入）
- [x] 架构规划（plan 模式，用户已批准）
- [x] 阶段 0：脚手架与工程化（AC0.1-0.4 全过）
- [x] 阶段 1：配置 + 日志 + LLM + REPL（AC1.1-1.4 全过；内部 OpenAI 兼容网关实测流式）
- [x] 阶段 2：core 管道 + 会话 + 命令 + 人设（AC2.1-2.5 全过；多轮记忆 / file store 重启实测）
- [x] 阶段 3：Telegram 适配器（代码 + 18 用例完成；AC3.1-3.6 真机联调待 bot token）
- [x] 阶段 4：飞书适配器（代码 + 19 用例完成；AC4.1-4.6 真机联调待自建应用凭据）
- [x] 阶段 5：健壮性打磨（优雅停机 / 进程兜底 / AC5.2 LLM 故障实测 PASS）；CHANGELOG / README 完稿
- [x] Telegram 真机联调第一轮：bot 上线，AC3.1 私聊流式回复、AC3.4 命令菜单 PASS（2026-11-06）
- [ ] AC3.2/3.3 群聊与超长回复真机测试（需先在 BotFather /setprivacy Disable）
- [ ] 飞书真机联调（等自建应用凭据）
- [ ] 提交代码 → 推远端 → CI 全绿 → tag v0.1.0

## 审查段

- 2026-11-06 阶段 0-2 完成：42 个单测全绿 + REPL 真实链路验证（内部 OpenAI 兼容网关）。
  证据：[v0.1-stage0-2/results.md](verification/v0.1-stage0-2/results.md)。
  教训：① readline promises 的连续 question() 在管道 stdin 下会挂起，已改事件驱动；
  ② 缺 key 的 provider 不能堵死启动，registry 改为懒校验（用到才报错）；
  ③ `sed` 全文替换勾选会误伤未验证的 AC，按行号回滚——验收状态只手改单行。
  ④ pino-pretty transport 是独立 worker 线程，退出前日志可能丢（生产 JSON 不受影响），阶段 5 停机时统一 flush。
- 2026-11-06 阶段 3-5 完成：78 个单测全绿；Telegram 节流/分段状态机重写一次（首条渲染与超长分段统一为 render 状态机）；
  飞书流式卡片采用 CardKit 全量更新方案，降级路径（创建失败/定稿失败→文本兜底）全部单测覆盖；
  AC5.2 实测：LLM 400 错误 → 用户友好文案 + 进程存活。
  证据：[v0.1-stage3-5/results.md](verification/v0.1-stage3-5/results.md)。
  教训：⑤ 飞书群聊 @ 判定需要 bot open_id，SDK 未封装 bot/v3/info，手写 REST（tenant_access_token + info）解决；
  ⑥ 卡片创建失败时降级文本只能发一次（append 里发一次 + finish 兜底一次会重复），统一由 finish/abort 兜底。
