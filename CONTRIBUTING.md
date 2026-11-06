# 贡献指南

感谢关注 moss-bots！欢迎 issue 与 PR。

## 本地开发

要求：Node.js ≥ 20.12。

```bash
npm install
cp config.example.yaml config.yaml
cp .env.example .env            # 填入至少一个 LLM API key
npm run chat                    # 终端 REPL：无需平台 token 即可跑通 LLM 全链路
npm run dev                     # 启动已启用的平台适配器
```

## 常用脚本

| 命令                              | 作用                                    |
| --------------------------------- | --------------------------------------- |
| `npm run dev`                     | 开发模式启动（tsx watch，改动自动重启） |
| `npm run chat`                    | 本地终端 REPL                           |
| `npm run test` / `test:watch`     | 运行测试（vitest）                      |
| `npm run typecheck`               | TypeScript 类型检查                     |
| `npm run lint`                    | ESLint                                  |
| `npm run format` / `format:check` | Prettier 格式化 / 检查                  |
| `npm run build`                   | 构建产物到 dist/                        |

## 提交约定

- Commit message 走 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)（`feat: ...` / `fix: ...` / `docs: ...`）
- PR 需包含对应测试；CI 全绿后才会被 review
- 新行为改动请在 `docs/` 下同步更新相关文档
- 不要在提交中包含任何真实密钥、token（示例配置一律用占位符）

## 代码约定

- 适配器只依赖 `src/adapters/types.ts` 与 `src/core`，平台之间不互相 import
- 确定性决策（重试、阈值、路由）写显式代码；不引入第一期 Roadmap 之外的抽象
