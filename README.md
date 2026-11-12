# moss-bots

中文 | [English](README.en.md)

接入 Telegram 与飞书的开源聊天机器人，底层可插拔任意 OpenAI 兼容大模型（Grok / OpenAI / DeepSeek / Ollama / vLLM …）。对标 grok bot：先做好聊天，后续逐步支持更复杂的任务执行。

## 特性

- **双平台**：Telegram（长轮询，免公网 IP）+ 飞书（WebSocket 长连接，免公网 IP / 免回调域名）
- **多模型可插拔**：任何 OpenAI 兼容端点皆可接入，`/model` 命令随时切换
- **流式回复**：Telegram 渐进编辑消息（Markdown 渲染，解析失败自动降级纯文本）、飞书流式卡片，打字机效果
- **可定制人设**：一个 Markdown 文件定义 bot 的性格
- **会话记忆**：按会话保存多轮上下文，`/reset` 一键清空
- **跨会话记忆**：bot 自动记住你是谁、聊过什么（`/memory` 查看、`/forget` 清除）
- **图片理解**：群里或私聊直接发图，支持视觉的模型（如 glm-5.3-flash）能看懂并接梗；不支持的模型会提示切换
- **联网搜索**：模型自主判断何时需要实时信息（新闻、赛果、价格），自动调用 web_search；同一会话 5 分钟冷却防烧额度
- **读链接**：用户粘贴 URL，bot 抓取网页正文来总结、讨论
- **定时提醒**：「明早 9 点提醒我交报告」自然语言即可设置，到点主动推送（`/remind` `/reminders` `/unremind`），重启不丢
- **自托管友好**：单二进制式部署（Docker 一条命令），无数据库、无 webhook 配置

## 命令

| 命令                    | 说明                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `/help`                 | 显示可用命令                                                     |
| `/models`               | 列出可用模型（标注当前）                                         |
| `/model [alias]`        | 查看/切换当前会话的模型                                          |
| `/compact`              | 把当前会话历史压缩成摘要（以你的需求为主线），长对话时释放上下文 |
| `/remember <内容>`      | 让 bot 记住一件事（如 /remember 我对花生过敏）                   |
| `/memory`               | 查看 bot 记住了关于你的什么                                      |
| `/forget`               | 清空 bot 关于你的记忆                                            |
| `/remind <时间> <内容>` | 到点提醒（如 /remind 09:00 起床），也可直接自然语言说            |
| `/reminders`            | 列出本会话待触发的提醒                                           |
| `/unremind <id>`        | 取消一个提醒                                                     |
| `/reset`                | 清空当前会话的对话历史                                           |

私聊直接发消息即可；群聊中命令可带 @bot 名或直接发送，聊天需 @bot 或回复 bot 的消息。

## 快速开始

```bash
git clone <repo-url> && cd moss-bots
npm install
cp config.example.yaml config.yaml
cp .env.example .env            # 填入至少一个 LLM API key
npm run chat                    # 终端 REPL，先验证模型链路，无需平台 token
```

### 接入 Telegram

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather) 发送 `/newbot`，拿到 token 填入 `.env` 的 `TELEGRAM_BOT_TOKEN`
2. `config.yaml` 中把 `telegram.enabled` 改为 `true`
3. `npm run dev`

### 接入飞书

1. 到 [飞书开放平台](https://open.feishu.cn/) 创建**企业自建应用**，在「凭证与基础信息」页拿到 App ID / App Secret 填入 `.env`
2. 「应用功能 → 机器人」**开启机器人能力**——不开此能力 bot 无法上线（接口报 11205）
3. 「开发配置 → 权限管理」开通以下权限（控制台搜索 scope 或近似中文名即可，名称以控制台实际为准）：

   | 权限 | scope | 用途 |
   |---|---|---|
   | 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 收私聊消息（与群聊权限相互独立，漏开表现为私聊不回） |
   | 读取群聊中@机器人他的消息 | `im:message.group_at_msg:readonly` | 收群聊 @ 消息 |
   | 获取与发送单聊、群组消息 | `im:message` | 发送回复、下载图片（图片理解依赖此权限） |
   | 创建、更新卡片（可选） | `cardkit:card` | 仅 `feishu.streaming: true` 流式卡片需要；不开建议保持 `streaming: false` |

4. 「事件与回调」页选择**长连接模式**，订阅事件 `im.message.receive_v1`（排查收不到消息时，先回这页核对订阅是否仍在）
5. **发布应用版本**——权限与事件变更必须发新版本才生效；然后把 `config.yaml` 中 `feishu.enabled` 改为 `true`
6. `npm run dev`

### 模型配置

`config.yaml` 中每个 provider 就是一个 OpenAI 兼容端点：

```yaml
providers:
  xai:
    baseUrl: https://api.x.ai/v1
    apiKeyEnv: XAI_API_KEY
  local:
    baseUrl: http://localhost:11434/v1 # Ollama
    apiKeyEnv: LOCAL_API_KEY
```

完整配置项见 [docs/CONFIG.md](docs/CONFIG.md)。

## Docker 部署

一键跑起来（镜像来自 ghcr.io，多架构 amd64/arm64）：

```bash
mkdir moss-bots && cd moss-bots && mkdir data prompts
base=https://raw.githubusercontent.com/ezcalm-code/moss_bot/main
curl -o config.yaml $base/config.example.yaml   # 编辑模型与平台
curl -o prompts/default.md $base/prompts/default.md
curl -o docker-compose.yml $base/docker-compose.yml
curl -o .env $base/.env.example && vi .env   # 填 API key
docker compose up -d && docker compose logs -f
```

从源码构建镜像：`docker build -t moss-bot .`（或 `docker compose up -d --build`）。

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## Roadmap

- [x] v0.1 聊天版：双平台接入、多模型、流式回复、人设、会话记忆
- [x] v0.2 多模态：图片理解（Markdown 渲染已随流式回复落地）
- [x] v0.3 联网搜索：web_search 工具 + Function Calling 框架（v2.1.0）
- [x] v0.4 任务执行第一步：定时提醒 + 群聊消息排队 + read_url（v2.2.0）
- [ ] 下一步：更多任务型工具（在 ToolRunner 上扩展），向「能真正干活」演进

进展明细见 [CHANGELOG.md](CHANGELOG.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
