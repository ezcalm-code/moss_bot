# moss-bots 开发约定

TypeScript 聊天机器人：Telegram + 飞书双平台，OpenAI 兼容多模型可插拔，对标 grok bot。
架构入口见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，配置说明见 [docs/CONFIG.md](docs/CONFIG.md)。

## 常用命令

```bash
npm run dev        # 启动 bot（Telegram/飞书按 config.yaml 的 enabled）
npm run chat       # 本地 REPL（无需平台 token，先验证模型链路）
npm test           # vitest 全量
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
node scripts/probe-gateway-tools.mjs [alias]   # 探测网关 function calling 透传（端点从 config.yaml 读）
```

## 提交脱敏红线（每次提交前必过）

本仓是公开开源项目，**任何内容推送后即视为公开**。两次事故教训（v0.1 配置 bak、v0.3 探测脚本）确立了以下红线，任何文件类型不过审不入库：

1. **逐行核对新增文件**：`git status --short` 逐个看文件名，示例配置、脚本、文档、fixture 都可能夹带内部信息；`git add -A` 只允许在文件清单已知时使用
2. **敏感串零容忍**，入库内容不得出现：
   - 内部域名 / 端点 URL（含探测、调试脚本里写死的 baseUrl）
   - 内部服务名 / provider 别名 / 内部模型路由串
   - 真实凭据与身份：API key、token、secret、真实姓名、邮箱、手机号
   - 本机信息：代理端口、本机路径、bot 真实用户名
3. **密钥只走 `.env`**（已 gitignore）：配置与脚本只写环境变量「名」（`apiKeyEnv` 等）；示例 / 模板 / 文档一律用 `replace_me` 类占位值
4. **脚本动态读取优先**：探测 / 临时脚本不写死端点——端点、模型、key 名一律从 `config.yaml` 或环境变量读取
5. **提交前自查**：`git grep -in "<敏感串清单>"` 零命中再提交；推送不可撤回，拿不准就先问用户
6. **泄漏处置**：revert / 删文件不删历史 blob——立即前向修复并上报用户，由用户决定是否重写历史
