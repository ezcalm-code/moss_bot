# 配置说明

moss-bots 配置由三层合并：`config.yaml`（主配置，不入库）+ `.env`（密钥，不入库）+ 内置默认值。优先级 **env > yaml > default**。启动时 zod 校验，失败会打印字段路径并退出。

**敏感信息约定**：配置文件只写环境变量「名」（`apiKeyEnv` 等），值放 `.env`。这样 `config.example.yaml` 可完整入库，`cp` 即用。

## 配置文件

路径由 `MOSS_CONFIG` 环境变量指定，缺省为工作目录下 `config.yaml`。

### log

| 字段  | 类型                       | 默认   | 说明     |
| ----- | -------------------------- | ------ | -------- |
| level | `debug\|info\|warn\|error` | `info` | 日志级别 |

### persona

| 字段             | 类型           | 默认     | 说明                                           |
| ---------------- | -------------- | -------- | ---------------------------------------------- |
| name             | string         | `Moss`   | bot 名字                                       |
| systemPrompt     | string         | 内置默认 | 内联 system prompt；与 systemPromptFile 二选一 |
| systemPromptFile | string（路径） | 无       | prompt 文件路径，相对 config.yaml 所在目录     |

### models

| 字段      | 类型   | 默认                | 说明                                            |
| --------- | ------ | ------------------- | ----------------------------------------------- |
| default   | string | entries[0] 的 alias | 默认模型 alias                                  |
| entries[] | 列表   | 必填                | alias / provider / model 三元组；alias 不可重复 |

`alias`：`/model` 命令用的短名；`provider`：对应 `providers` 的 key；`model`：传给 API 的 model 参数。

entry 还支持可选 `supportsTools: false`：该模型不参与工具调用（function calling）。缺省视为支持；网关不透传 tools 或模型不支持时，运行时也会自动探测标记（首次 4xx 后该模型不再挂工具）。

### providers

Record 类型，key 为 provider id。

| 字段      | 类型          | 说明                     |
| --------- | ------------- | ------------------------ |
| baseUrl   | string（URL） | OpenAI 兼容端点          |
| apiKeyEnv | string        | 环境变量名（推荐）       |
| apiKey    | string        | 内联 key（仅本地调试用） |

### session

| 字段               | 类型           | 默认     | 说明                         |
| ------------------ | -------------- | -------- | ---------------------------- |
| store              | `memory\|file` | `memory` | file 落盘到 `data/sessions/` |
| maxHistoryMessages | int ≥2         | `40`     | 单会话历史上限，超出裁剪最旧 |

### telegram

| 字段        | 类型   | 默认                 | 说明               |
| ----------- | ------ | -------------------- | ------------------ |
| enabled     | bool   | `false`              |                    |
| botTokenEnv | string | `TELEGRAM_BOT_TOKEN` | token 的环境变量名 |

### feishu

| 字段         | 类型           | 默认                | 说明                                     |
| ------------ | -------------- | ------------------- | ---------------------------------------- |
| enabled      | bool           | `false`             |                                          |
| appIdEnv     | string         | `FEISHU_APP_ID`     |                                          |
| appSecretEnv | string         | `FEISHU_APP_SECRET` |                                          |
| domain       | `feishu\|lark` | `feishu`            | lark 为国际版                            |
| streaming    | bool           | `true`              | CardKit 流式卡片；失败自动降级为普通消息 |

### memory

| 字段    | 类型 | 默认   | 说明                                                                          |
| ------- | ---- | ------ | ----------------------------------------------------------------------------- |
| enabled | bool | `true` | 跨会话用户记忆；画像按用户存于 `data/memory/`，`/memory` 查看、`/forget` 清除 |

记忆机制：每轮回复后后台提取值得长期保留的事实（身份、偏好、进行中的事），敏感信息（密码/证件/住址）即使提到也不记录。画像为 Markdown 文本，可直接手改。

### tools

| 字段                          | 类型    | 默认     | 说明                                     |
| ----------------------------- | ------- | -------- | ---------------------------------------- |
| webSearch.enabled             | bool    | `false`  | 打开后模型可自主调用 web_search 联网搜索 |
| webSearch.provider            | string  | `tavily` | 搜索源，对应 webSearch.providers 的 key  |
| webSearch.maxResults          | int 1-10 | `5`      | 单次搜索返回条数                         |
| webSearch.cooldownMinutes     | number  | `5`      | 同一会话（群/私聊各自）搜索冷却          |
| webSearch.providers.<id>      | record  | 无       | 各搜索源配置：apiKeyEnv（必填）、baseUrl（可选，自托管源用） |

工具机制：请求时把工具定义（OpenAI function tools 格式）随消息发给模型，模型判断需要实时信息时返回 `web_search` 调用，bot 执行搜索后把结果回传，模型组织成最终回答——触发与否完全由模型判断。同一会话 5 分钟内只放行一次搜索（冷却期内模型会收到说明并向用户解释）；搜索失败或冷却都不会中断对话。当前仅支持 Tavily（免费档 1000 次/月，[tavily.com](https://tavily.com) 邮箱注册）；带图消息的轮次不挂工具。

## 启动期校验规则

- `persona.systemPrompt` 与 `persona.systemPromptFile` 只能配置其一
- `models.entries` 的 alias 不可重复；`models.default`（若设置）必须存在于 entries；entry 的 provider 必须存在于 `providers`
- `telegram.enabled=true` 时对应 token 环境变量必须非空，否则启动报错（feishu 同理）
- `tools.webSearch.enabled=true` 时 `provider` 必须在 `providers` 中定义、对应 API key 环境变量必须非空

## 环境变量

见 [.env.example](../.env.example)。常用：`TELEGRAM_BOT_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`XAI_API_KEY`、`DEEPSEEK_API_KEY`、`MOSS_CONFIG`（配置文件路径）。

## 网络代理（国内部署 Telegram 必读）

api.telegram.org 在国内网络不可直连。检测到 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量时，bot 会自动经代理出站（undici dispatcher，显式注入 grammY 与 openai SDK）；`NO_PROXY` 中的地址直连。无代理环境行为不变。注意 Docker 部署时容器内 `127.0.0.1` 不是宿主机，代理地址需写宿主机可达地址（如 `http://host.docker.internal:7890`）。飞书接口国内可直连，无需代理。
