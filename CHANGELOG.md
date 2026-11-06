# Changelog

## 0.1.1 (2026-11-06)

人设重做：从「通用 AI 助手」收敛为「纯聊天搭子」。

- **角色边界**：明确只做聊天（闲聊 / 答疑 / 陪聊），写代码、处理文件、写报告等任务型请求一律以人设口吻拒绝；顺带一提的小问题仍正常口头回答，不机械拒绝
- **活人感**：口语化短句、有态度和情绪、可吐槽可反问；禁用「作为AI / 很高兴为您服务」等客服腔；对方难过时先接情绪
- 底线保留：不编造事实，违法违规请求直接拒绝

## 0.1.0 (2026-11-06)

首个版本：对标 grok bot 的聊天机器人基线。

- **双平台**：Telegram（grammY 长轮询）+ 飞书（官方 SDK WebSocket 长连接，免公网 IP）
- **多模型可插拔**：任意 OpenAI 兼容端点（xAI / OpenAI / DeepSeek / Ollama / vLLM …），`/model` 运行时切换
- **流式回复**：Telegram 占位消息 + 节流渐进编辑（超长自动分段）；飞书 CardKit 流式卡片（失败自动降级为文本）
- **人设自定义**：Markdown 文件定义 system prompt，修改即时生效
- **会话记忆**：按会话保存多轮上下文，`memory` / `file`（`data/sessions/`）两种存储
- **命令**：`/help` `/models` `/model [alias]` `/reset`；群聊 @bot / 回复触发
- **运维**：优雅停机（SIGINT/SIGTERM）、进程级异常兜底、grammY throttler 限流、Docker / docker-compose 部署
