import { join } from 'node:path';
import { FeishuAdapter } from './adapters/feishu';
import { TelegramAdapter } from './adapters/telegram';
import type { PlatformAdapter } from './adapters/types';
import { loadConfig, loadEnvFile } from './config/load';
import { getProxyDispatcher } from './proxy';
import { BotCore } from './core/bot';
import { SessionManager } from './core/session';
import { buildRegistry } from './llm/registry';
import { createLogger } from './log';
import { UserMemoryStore } from './memory/store';
import { FileSessionStore } from './stores/file';
import { MemorySessionStore } from './stores/memory';
import { VERSION } from './version';

async function main(): Promise<void> {
  loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const log = createLogger(config.log.level);
  const proxyDispatcher = getProxyDispatcher();

  const registry = buildRegistry(config, proxyDispatcher);
  const store =
    config.session.store === 'file'
      ? new FileSessionStore(join('data', 'sessions'), log)
      : new MemorySessionStore();
  const sessions = new SessionManager(store, config.session.maxHistoryMessages);
  const memory = config.memory.enabled ? new UserMemoryStore(join('data', 'memory')) : undefined;
  const bot = new BotCore({
    registry,
    sessions,
    systemPrompt: config.persona.systemPrompt,
    personaName: config.persona.name,
    log,
    memory,
  });

  const adapters: PlatformAdapter[] = [];
  if (config.telegram.enabled) {
    adapters.push(
      new TelegramAdapter({ botToken: config.telegram.botToken as string, log, proxyDispatcher }),
    );
  }
  if (config.feishu.enabled) {
    adapters.push(
      new FeishuAdapter({
        appId: config.feishu.appId as string,
        appSecret: config.feishu.appSecret as string,
        domain: config.feishu.domain,
        streaming: config.feishu.streaming,
        log,
      }),
    );
  }

  if (adapters.length === 0) {
    log.info(
      '未启用任何平台。本地体验请运行 npm run chat（终端 REPL）；接入 Telegram/飞书见 docs/CONFIG.md 与 README。',
    );
    return;
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, '收到停机信号，优雅关闭中');
    void Promise.all(
      adapters.map(async (a) => {
        try {
          await a.stop();
        } catch (err) {
          log.warn({ err, adapter: a.id }, '适配器停机失败');
        }
      }),
    ).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaughtException');
    shutdown('uncaughtException');
  });

  for (const adapter of adapters) {
    adapter.setDispatcher((msg) => bot.handle(msg));
    if (adapter.registerCommands) {
      try {
        await adapter.registerCommands(bot.commands.menu());
      } catch (err) {
        // 命令菜单只是 UI 便利功能，注册失败不应阻止 bot 上线
        log.warn({ err, adapter: adapter.id }, '命令菜单注册失败，继续启动');
      }
    }
  }

  await Promise.all(adapters.map((a) => a.start()));
  log.info(
    { version: VERSION, platforms: adapters.map((a) => a.id), defaultModel: registry.defaultAlias },
    `moss-bots v${VERSION} 已启动`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
