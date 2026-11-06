# Changelog

## Unreleased

- **桌面渠道管理工具**（`desktop/`，基于 [MyGo](https://github.com/egoist/mygo) 原生 UI）：模型渠道的添加 / 修改 / 删除 / 切换默认，保存前交叉校验（重复 alias、未知 provider、非法 baseUrl、缺 key 来源），改动即时写回 `config.yaml` 且保留其他配置段与注释；纯 Go 单文件二进制，无 WebView，低内存占用

## 0.1.0 (2026-11-06)

首个版本：对标 grok bot 的聊天机器人基线。

- **双平台**：Telegram（grammY 长轮询）+ 飞书（官方 SDK WebSocket 长连接，免公网 IP）
- **多模型可插拔**：任意 OpenAI 兼容端点（xAI / OpenAI / DeepSeek / Ollama / vLLM …），`/model` 运行时切换
- **流式回复**：Telegram 占位消息 + 节流渐进编辑（超长自动分段）；飞书 CardKit 流式卡片（失败自动降级为文本）
- **人设自定义**：Markdown 文件定义 system prompt，修改即时生效
- **会话记忆**：按会话保存多轮上下文，`memory` / `file`（`data/sessions/`）两种存储
- **命令**：`/help` `/models` `/model [alias]` `/reset`；群聊 @bot / 回复触发
- **运维**：优雅停机（SIGINT/SIGTERM）、进程级异常兜底、grammY throttler 限流、Docker / docker-compose 部署
