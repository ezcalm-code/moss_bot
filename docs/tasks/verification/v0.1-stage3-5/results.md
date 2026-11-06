# v0.1 阶段 3-5 验收证据

日期：2026-11-06 · 环境：Windows 11 / Node v20.20.0

## 结果表

| 标准                                   | 用例                                                       | 命令                                                           | 实际结果                                                                                         |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AC3.1 私聊流式回复（真机）             | TelegramStreamReply 单测                                   | `npx vitest run src/adapters/telegram/stream.test.ts`          | 代码层 PASS（10 用例：首条快出/节流/finish 定稿/超长分段/abort）；真机联调 **待 bot token**      |
| AC3.2 群聊 @ / 回复触发 + 剥离（真机） | normalize.test.ts                                          | `npx vitest run src/adapters/telegram/normalize.test.ts`       | 代码层 PASS（8 用例：mention 剥离 / reply-to-bot / 非 targeted 忽略）；真机联调 **待 bot token** |
| AC3.3 超长分段                         | stream.test.ts「超长内容分段定稿续发」                     | 同上                                                           | PASS：35 字符 maxLen10 → 3 段定稿 + 尾段编辑                                                     |
| AC3.4 命令菜单                         | registerCommands → setMyCommands                           | 真机                                                           | **待 bot token**（BotFather 菜单肉眼验证）                                                       |
| AC3.5 LLM 4xx/5xx 不崩                 | 手动（REPL 等价路径）                                      | 配错 model 名跑 REPL                                           | PASS：`出错了: 400 model not found`，后续 /models 正常，exit 0（见 AC5.2）                       |
| AC3.6 Ctrl+C 干净退出（真机）          | 优雅停机代码                                               | `npx tsx src/index.ts`（no-platform 路径）                     | PASS（exit 0）；SIGINT/SIGTERM handler 已注册，真机联调待 token                                  |
| AC4.1 飞书私聊回复（真机）             | —                                                          | —                                                              | **待飞书自建应用凭据**                                                                           |
| AC4.2 群聊 @bot 剥离                   | normalize.test.ts                                          | `npx vitest run src/adapters/feishu/normalize.test.ts`         | 代码层 PASS（8 用例，含 mention 占位符剥离、他人 mention 还原）                                  |
| AC4.3 流式卡片                         | stream.test.ts（FeishuStreamReply）                        | `npx vitest run src/adapters/feishu/stream.test.ts`            | 代码层 PASS（创建/节流更新/sequence 递增/finish 定稿）；真机联调 **待凭据**                      |
| AC4.4 streaming:false                  | FeishuSimpleReply 用例                                     | 同上                                                           | PASS：append 累积、finish 一次性全文                                                             |
| AC4.5 断网重连                         | SDK 内建 autoReconnect + onReconnecting/onReconnected 日志 | 真机                                                           | **待凭据**（代码已接回调，日志可见）                                                             |
| AC4.6 命令一致性                       | core 命令系统平台无关（bot.test.ts 18 用例）               | `npm test`                                                     | PASS：命令解析与执行不依赖平台                                                                   |
| AC5.1 双平台 Docker + 会话保留         | docker compose build + file store                          | `docker compose build`                                         | build PASS（moss-bots:latest）；双平台 compose up 真机验证 **待凭据**                            |
| AC5.2 LLM 故障不崩                     | 手动                                                       | `MOSS_CONFIG=./config-bad.yaml（model 名配错）`                | PASS：用户收到「出错了: 400 model not found」，进程继续响应 /models，exit 0                      |
| AC5.3 CI 全绿 + tag                    | GitHub Actions（Node 20/22 矩阵）                          | push f465303 后 `GET /repos/ezcalm-code/moss_bot/actions/runs` | PASS：conclusion=success；tag v0.1.0 已推送                                                      |

## 发布记录

- 远端：https://github.com/ezcalm-code/moss_bot（main + tag v0.1.0）
- 提交前完成敏感信息三轮审查：密钥（Telegram token / LLM key）均在 gitignored `.env`；文档中内部网关域名、内部服务名、bot 用户名、本机代理端口已全部脱敏（2026-11-06）
- 仓库级 git 身份用个人邮箱 + GitHub 用户名（公司邮箱不入公开历史）

## 代码层全量回归（2026-11-06 11:30）

```
npm run typecheck  PASS
npm run lint       PASS
npm test           PASS：78 tests / 8 files
npm run build      PASS：dist/ (index + cli/repl)
```

## 待真机联调清单（用户凭据就位后）

1. `.env` 填 `TELEGRAM_BOT_TOKEN`，`config.yaml` 开 `telegram.enabled: true` → `npm run dev` → 私聊/群聊/超长回复/菜单/Ctrl+C（AC3.1-3.6）
2. `.env` 填 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，开 `feishu.enabled: true` → 私聊/群聊/流式卡片/降级/断网重连（AC4.1-4.6）
3. 双平台同开 `docker compose up`（AC5.1）

## 真机联调补充（2026-11-06 11:48，Telegram 真机）

| 项目               | 结果                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| AC3.4 命令菜单     | PASS：`getMyCommands` 返回 help/models/model/reset 四条中文描述                                                     |
| AC3.1 私聊流式回复 | PASS：用户在 Telegram 私聊实测「可以了」（打字机式渐进回复正常）                                                    |
| 启动日志           | 干净：`moss-bots v0.1.0 已启动` → `telegram bot 已启动（长轮询）`，无错误                                           |
| AC3.2 群聊         | 待测：bot 当前为隐私模式（`can_read_all_group_messages: false`），需 BotFather `/setprivacy` → Disable 后再拉群验证 |

### 代理修复（真机联调发现的环境问题，已根修）

现象：`setMyCommands` 网络失败，进程 fail-fast 退出（exit 1）。
根因：本机经 `HTTP_PROXY`（本地代理）出墙访问 api.telegram.org，但 Node 内置 fetch 与 grammY 自带的 node-fetch v2 均不读代理环境变量。
修复：新增 `src/proxy.ts` 的 `getProxyDispatcher()`（undici `EnvHttpProxyAgent`），显式注入 grammY `client.baseFetchConfig.dispatcher` 与 openai SDK `fetchOptions.dispatcher`。要点：

- npm undici 包的 `setGlobalDispatcher` 与 Node 内置 fetch 的全局 dispatcher 不互通（globalThis symbol 版本不同），必须显式传；
- grammY 必须显式传 `client.fetch: globalThis.fetch`，否则默认 node-fetch v2 忽略 dispatcher 字段。
  无代理环境返回 undefined，行为不变；国内部署 Telegram 必配 `HTTPS_PROXY` 已写入部署心智（docs/CONFIG.md 待补）。

## 备注

- 飞书 bot open_id 通过手写 REST 获取（SDK 未封装 bot/v3/info）；群聊 @ 判定依赖它。
- 流式卡片用 CardKit「创建实体 → 发送引用消息 → 全量更新（sequence 递增）」方案；SDK 类型已核对（cardkit.v1.card.create/update）。
- index.ts no-platform 启动路径实测：提示 npm run chat，exit 0。
