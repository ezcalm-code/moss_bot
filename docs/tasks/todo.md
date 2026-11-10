# moss-bots 任务清单

## 原始需求（原话，唯一锚点）

> 接入telegram、飞书，帮忙完成一些任务，前期主要做聊天、后期可以执行一些较难的任务，对标grok bot

## 我的理解（与原话并列）

- 核心形态：开源聊天机器人，对标 grok bot（X 平台上 Grok 驱动的回复 bot）
- 平台：Telegram + 飞书，适配器模式，后续可扩展
- 分期：前期只做聊天；「执行较难的任务」（tool use / agent 能力）是后期目标，本期只留扩展点
- 已拍板：TypeScript；LLM 层 OpenAI 兼容、多模型可插拔
- 项目名沿用目录名 moss-bots

计划全文（原 docs/ROADMAP.md，v0.1 五阶段）已随 2.x 实际走向分叉，2026-11-09 删除，原文可从 git 历史回溯；架构见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md)。

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
- [x] AC3.2 群聊真机通过；AC3.3 超长分段仍挂账（见下方挂账条）
- [x] 飞书真机联调打通（2026-11-09，私聊/群聊/图片/命令全过，见审查段）
- [x] 提交前脱敏：三轮敏感信息审查（密钥全在 gitignored .env；文档内部域名/服务名/bot 用户名/代理端口已脱敏）
- [x] 提交代码 → 推远端 → CI 全绿 → tag v0.1.0（2026-11-06，github.com/ezcalm-code/moss_bot）
- [x] 多模态里程碑：图片理解 / 回复取图 / 飞书 post 富文本 / 飞书图片与重复回复修复（2026-11-09）
- [x] release v2.0.0：CHANGELOG 定稿 + package.json 2.0.0 + tag 推送 + CI 绿（87af7d0，本机无 gh，以 tag 为 release）
- [x] 实时互联网消息：用户选定方案 B，已实施并发布（见下方方案 B 条）
- [x] 方案 B 实施：工具框架 + web_search（Tavily）+ 5 分钟冷却 + supportsTools 能力位（2026-11-09，150 测试全绿，REPL 三场景实测，9e27f4d）
  - 证据：[v0.3-tools/results.md](verification/v0.3-tools/results.md)
  - 教训：⑮ `const res = await opts.fetch ? a() : b()` 的 await 只作用于条件本身，res 拿到的是未 await 的 Promise——ternary 里的副作用调用必须整体先赋值再 await（tavily.test.ts 首轮全红抓出）
- [x] 真实 Tavily key 就位：REPL 搜索成功路径实测 PASS（当日真实新闻 + 细节，0 失败），bot 重启生效
- [x] 脱敏返工（用户提醒）：探测脚本写死内部网关域名随 9e27f4d 推送——脚本重写为从 config.yaml 动态读端点/model（改名 probe-gateway-tools.mjs），验证文档抹掉内部 provider 别名/模型串。
  教训：⑯ **脱敏清单要覆盖所有新增文件类型**——这次是 `scripts/`（上次是配置 bak，教训⑩同类）：临时/探测脚本天然会写死内部端点，入库前按「示例配置」同一标准过一遍；
  ⑪ 同样适用：旧提交 9e27f4d 的 blob 仍含域名，彻底清除需用户拍板历史重写
- [x] TG/飞书真机验收通过（2026-11-09，用户确认）
- [x] release v2.1.0：联网搜索 + 工具框架（CHANGELOG 定稿 + tag 推送 + GitHub Release + CI 绿）
- [x] 三项改进（2026-11-09，c9b25ea，163 测试全绿，REPL 实测 read_url PASS）：飞书流式卡片修复（sequence 起始 1，官方文档确认）+ per-chat 消息排队（深度≥5 丢弃）+ read_url 读链接工具（Tavily Extract）；README/ROADMAP 清理（56531d5）
  - 证据：[v0.3-tools/results.md](verification/v0.3-tools/results.md) 三项改进小节
- [x] v0.4 主体（2026-11-09，e052e9a，180 测试全绿）：定时提醒（自然语言工具+/remind 命令+持久化+重启补投+双平台 sendTo）、TG Markdown 渲染（400 降级纯文本）、同轮搜索放行+轮数上限 5
  - 证据：[v0.4-reminders/results.md](verification/v0.4-reminders/results.md)
  - 教训：⑰ REPL 退出被 pino-pretty worker 挂住——exitCode 软退出永不生效、stdout 回调式退出在 /dev/null 下不触发，进程曾存活到提醒到期把它投进 /dev/null（「补投无打印」假象的根源）；解法是普通 timer 兜底硬退。⑯ 同源提醒：**验证时要核对进程真的退了**，盘上状态变化可能是别的存活进程干的
- [x] v0.4 真机验收通过（2026-11-10，日志核验）：双平台提醒到点推送、TG Markdown 400 降级兜住、同轮连招四连零拦截——证据补入 results.md 真机验收小节
- [ ] 挂账：AC3.3 TG 群聊超长回复分段、群刷屏丢弃真机触发、desktop 分支合并决策
- [ ] 暂缓（用户决策 2026-11-10）：热榜订阅工具——「对目前产品用户价值不大」。已调研结论留档：微博/知乎热榜走第三方聚合源（稳定性一般需多源互备），HackerNews/GitHub 走官方源；场景覆盖热榜速览、聊天素材、「发现→深挖」连招、关键词盯梢。想做时从挂账捞起
- [x] CI 失败结案（2026-11-10）：8c86fcb 失败于 npm run lint（prefer-const，修复在 e052e9a）；其后 c0335ff 失败于 typecheck——v0.4 提交漏 add 了 src/tools/index.test.ts 的 ToolContext fixture 修复（本地绿 CI 红的根因），补提交 404f665 后 CI 全绿
  - 教训：⑱ **本地三检全绿 ≠ 提交内容三检全绿**——逐文件 git add 时漏掉一个测试文件，本地修复没进提交树；提交后跑一次 `git status --short` 确认零残留，或直接以提交树为准重跑三检

- [x] v0.5 主体（2026-11-10，197 测试全绿）：每日播报（自然语言+命令、到点搜索生成推送）、群投票（TG 原生 poll + 飞书卡片回调计票）、加密笔记（AES-256-GCM，无 key 禁用无明文模式）、timezone 配置基建（Docker UTC 坑）
  - 证据：[v0.5/results.md](verification/v0.5/results.md)
  - 教训：⑲ 飞书 WS 模式没有独立 cardDispatcher——SDK 源码确认卡片回调按 event_type `card.action.trigger` 走同一个 EventDispatcher（README 记忆的 CardActionHandler+cardDispatcher 是 HTTP webhook 用法）；`WSClient.start` 只收 eventDispatcher
- [ ] v0.5 真机验收（用户）：TG/飞书 /poll 投票（飞书需先后台开启卡片回调订阅）、次日播报推送
- [ ] 发版 v2.3.0：CHANGELOG + 版本号 + tag + GitHub Release

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
- 2026-11-06 v0.1.1 人设重做发布（纯聊天搭子 + 活人感），REPL 三场景实测通过，真机重启生效。
  证据：REPL 实测记录（拒绝爬虫请求/口头答疑/情绪接住）。
  **事故记录**：格式修正时用 `git add -A`，把 `config.yaml.bak`（含内部网关域名与变量名，无 key 值）、`.idea/`、`moss-config.exe` 意外提交并推送——根因是 main 回退后 `.gitignore` 防护规则消失（规则在 feat 分支提交里），工作区本地文件裸奔。已立即 revert（7cc9553）并在 main 补齐防护（13b720d）。
  教训：⑩ **分支切换/回退后必须先确认 .gitignore 仍覆盖全部本地产物，再执行 add**；提交前 `git status --short` 要逐行核对新增文件名，`add -A` 只允许在文件清单已知时使用；
  ⑪ revert 不删历史：泄露文件内容在 4d5e79d commit 中仍可达，彻底清除需用户自行 force push（权限红线，工具不代执行）。
- 2026-11-09 飞书联调打通（私聊/群聊/图片/命令全部真机验证）。联调踩坑全记录（按遇到顺序）：
  ① 应用未开「机器人」能力 → bot/v3/info 报 11205 app do not have bot；
  ② bot/v3/info 实测响应顶层是 bot.open_id（无 data 包裹层，按文档记忆写的 data.open_id 读不到）；
  ③ 私聊收不到消息是独立权限 im:message.p2p_msg（群聊权限 p2p 各自独立）；
  ④ 图片消息 content 是 {"image_key":...}，写成 .image 则提取为空；
  ⑤ 图+文消息实为 post 富文本，需专门解析（extractPostContent）；
  ⑥ 事件未及时确认会被飞书重推 → 同一条消息回复两次（handler 必须快速 ack，业务异步派发）；
  ⑦ 事件订阅配置可能随版本发布漂移，排错先查后台「事件与回调」页；
  ⑧ messageResource.get 返回包装对象，getReadableStream() 才是流。
  教训：⑫ 飞书 API 的字段名/响应结构与文档记忆差异大，**一律以真机事件/响应实测为准**，联调时先打结构日志再写解析；
  ⑬ 重启命令链中 grep 无匹配返回非零会静默断链——「重启未生效、旧进程还在跑」排障 30 分钟，**重启类操作必须分步执行并核对进程**；
  ⑭ 用户报「读不到图」要区分场景（直接发图 / 回复图文 post / 回复纯图）——每种场景的代码路径不同，先加路径追踪日志再定位。
