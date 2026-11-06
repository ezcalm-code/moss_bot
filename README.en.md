# moss-bots

[中文](README.md) | English

An open-source chat bot for Telegram and Feishu (Lark), pluggable with any OpenAI-compatible LLM (Grok / OpenAI / DeepSeek / Ollama / vLLM ...).

## Features

- **Two platforms**: Telegram (long polling, no public IP needed) + Feishu (WebSocket long connection, no public IP / webhook domain needed)
- **Pluggable models**: any OpenAI-compatible endpoint; switch at runtime with `/model`
- **Streaming replies**: progressive message editing on Telegram, streaming cards on Feishu
- **Customizable persona**: define your bot's personality in a single Markdown file
- **Session memory**: multi-turn context per conversation, `/reset` to clear
- **Self-hosting friendly**: single-command Docker deploy, no database, no webhook config

## Quick start

```bash
git clone <repo-url> && cd moss-bots
npm install
cp config.example.yaml config.yaml
cp .env.example .env            # fill in at least one LLM API key
npm run chat                    # terminal REPL, verifies the LLM pipeline without platform tokens
```

See the [Chinese README](README.md) for full platform setup guides (currently Chinese-first), or [docs/CONFIG.md](docs/CONFIG.md) for all configuration options.

## License

[MIT](LICENSE)
