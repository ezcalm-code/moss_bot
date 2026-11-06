# v0.1 阶段 0-2 验收证据

日期：2026-11-06 · 环境：Windows 11 / Node v20.20.0 / npm 10.8.2 · commit：见 git log

## 结果表

| 标准                          | 用例                          | 命令                                                                       | 实际结果                                                                                                                                           |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC0.1 install 一次成功        | —                             | `npm install`                                                              | PASS：added 281 packages（zod4/openai peer 冲突经 overrides 解决）                                                                                 |
| AC0.2 三检全绿                | 全部单测                      | `npm run typecheck && npm run lint && npm test`                            | PASS：0 错误，42 tests passed（4 files）                                                                                                           |
| AC0.3 dev 打印摘要/缺失报错   | 手动                          | `npx tsx src/index.ts` / `MOSS_CONFIG=./no-such.yaml npx tsx src/index.ts` | PASS：打印 v0.1.0 + 配置摘要（persona 158 chars），exit 0；缺失时报「配置文件不存在: ./no-such.yaml（可复制 config.example.yaml 作为起点）」exit 1 |
| AC0.4 docker build            | —                             | `docker compose build`                                                     | PASS：Image moss-bots:latest Built（exit 0）                                                                                                       |
| AC1.1 配置报错含字段路径      | src/config/schema.test.ts     | `npm test`                                                                 | PASS：「非法 log.level 报错且含字段路径」等 13 用例                                                                                                |
| AC1.2 REPL 逐字流式输出       | 手动（内部 OpenAI 兼容网关）  | `printf '一句话介绍你自己\nexit\n' \| npx tsx src/cli/repl.ts`             | PASS：真实流式输出「我是 Moss，一个部署在 Telegram 和飞书上的 AI 助手…」（人设生效）；mock SSE 聚合另见 openai-compat.test.ts                      |
| AC1.3 优雅退出                | 手动                          | `printf 'hi\nexit\n' \| npx tsx src/cli/repl.ts; echo $?`                  | PASS（EOF 路径 exit 0）；交互 Ctrl+C 走 `process.on('SIGINT')` 同路径，待平台真机联调时复核                                                        |
| AC1.4 mock SSE 聚合           | src/llm/openai-compat.test.ts | `npm test`                                                                 | PASS：3 用例（delta 序列/空 delta 跳过/请求参数）                                                                                                  |
| AC2.1 多轮上下文              | 手动                          | `printf '我叫小明…\n我叫什么名字？\nexit\n' \| npx tsx src/cli/repl.ts`    | PASS：第二轮准确答「小明」                                                                                                                         |
| AC2.2 /model 即时生效         | 手动 + bot.test.ts            | REPL 内 `/models`、`/model ds-chat`、`/model glm`                          | PASS：/models 标注当前；切换后下一轮请求 model 参数变化（缺 key 的 ds-chat 报错优雅不崩，日志含 ConfigError 详情）                                 |
| AC2.3 /reset /help + 命令单测 | src/core/bot.test.ts + 手动   | `npm test` + REPL `/reset`                                                 | PASS：18 用例（含 `/model@grok_bot` 剥离、alias、未知命令）；REPL 实测「已清空当前会话的对话历史」                                                 |
| AC2.4 历史裁剪                | src/stores/session.test.ts    | `npm test`                                                                 | PASS：「超过 maxHistoryMessages 裁掉最旧的消息」保留 msg-4..msg-7                                                                                  |
| AC2.5 file store 重启保留     | 手动 + session.test.ts        | `store: file` 两次启动 REPL；`ls data/sessions/`                           | PASS：第一次「我叫小红」→ 重启后答「小红。」；落盘 `data/sessions/cli%3Alocal.json`                                                                |

## 备注

- REPL 管道模式曾出现连续 `rl.question()` 挂起（readline promises API 在管道 stdin 下的已知行为），已改为事件驱动主循环（src/cli/repl.ts 注释注明原因）。
- LLM 端点：一个内部 OpenAI 兼容网关（域名与模型名不入库），Bearer key 走 `.env`；该 provider 仅存在于本地 config.yaml（gitignored），不入库、不进 example 配置。
- pino-pretty 的 transport 为独立 worker 线程，进程退出前最后几条日志可能延迟/丢失（dev 体验问题，生产为 JSON 无此问题）；阶段 5 优雅停机时统一处理 logger flush。
