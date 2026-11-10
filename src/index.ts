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
import { createAddNoteTool } from './notes/notes-tool';
import { NotesService } from './notes/service';
import { NotesStore } from './notes/store';
import { createReminderTool } from './reminders/reminder-tool';
import { ReminderService } from './reminders/service';
import { ReminderStore } from './reminders/store';
import { BroadcastService, type BroadcastGenerate } from './broadcasts/service';
import { BroadcastStore } from './broadcasts/store';
import { createScheduleBroadcastTool } from './broadcasts/broadcast-tool';
import { createImageProvider } from './images';
import { createGenerateImageTool } from './images/image-tool';
import { ImageService } from './images/service';
import { createSearchProvider, createToolRunner } from './tools';
import { PollsService } from './polls/service';
import { createCreatePollTool } from './polls/poll-tool';
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
  const reminders = new ReminderService(new ReminderStore(join('data', 'reminders'), log), log);
  // 笔记模块需要加密密钥：未配置 NOTES_ENCRYPTION_KEY 时整体不装配（不提供明文模式）
  const notesKey = process.env.NOTES_ENCRYPTION_KEY;
  const notes = notesKey
    ? new NotesService(new NotesStore(join('data', 'notes', 'notes.bin'), notesKey))
    : undefined;
  // 每日播报生成：搜索 + 摘要（不进会话历史；每条每天 1 次搜索 + 1 次 LLM）
  const searchProvider = createSearchProvider(config.tools, proxyDispatcher);
  const broadcasts = searchProvider
    ? new BroadcastService(new BroadcastStore(join('data', 'broadcasts'), log), config.timezone, log)
    : undefined;
  const generate: BroadcastGenerate = async (b) => {
    if (!searchProvider) return '播报功能未启用。';
    const results = await searchProvider.search(b.query, { maxResults: 5 });
    if (results.length === 0) {
      return `没搜到与「${b.query}」相关的内容。`;
    }
    const formatted = results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content.slice(0, 300)}`)
      .join('\n\n');
    return registry.chat(undefined, [
      {
        role: 'user',
        content: [
          `今天是 ${new Date().toLocaleDateString('zh-CN')}。用户订阅了每日播报，主题：「${b.query}」。`,
          '请根据下面的搜索结果写一段 200 字以内的中文摘要，口语化、有信息量，末尾附上 1-2 个信息源链接。',
          '搜索结果：',
          formatted,
        ].join('\n'),
      },
    ]);
  };
  const polls = new PollsService(log);
  // 生图：未启用或未配置 key 时整体不装配（REPL 无发图通道，repl.ts 不装配）
  const imageProvider = createImageProvider(config.imageGeneration, proxyDispatcher);
  const images = imageProvider
    ? new ImageService(imageProvider, config.imageGeneration.cooldownMinutes, log)
    : undefined;
  const tools = createToolRunner(config.tools, proxyDispatcher, [
    createReminderTool({ service: reminders }),
    ...(notes ? [createAddNoteTool({ service: notes })] : []),
    ...(broadcasts ? [createScheduleBroadcastTool({ service: broadcasts })] : []),
    createCreatePollTool({ service: polls }),
    ...(images ? [createGenerateImageTool({ service: images })] : []),
  ]);
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
    tools,
    timezone: config.timezone,
    reminders,
    notes,
    broadcasts,
    polls,
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
        polls,
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
    reminders.stop();
    broadcasts?.stop();
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
  // 提醒投递路由到对应平台；平台未启用时丢弃并留痕（该会话在当前部署不可达）
  reminders.start(async (platform, chatId, text) => {
    const adapter = adapters.find((a) => a.id === platform);
    if (!adapter) {
      log.warn({ platform, chatId }, '提醒目标平台未启用，丢弃该提醒');
      return;
    }
    await adapter.sendTo(chatId, text);
  });
  for (const adapter of adapters) {
    if (adapter.id === 'telegram') {
      polls.registerSender('telegram', (chatId, _pollId, question, options) =>
        (adapter as TelegramAdapter).sendPoll(chatId, question, options),
      );
    }
    if (adapter.id === 'feishu') {
      polls.registerSender('feishu', (chatId, pollId, question, options) =>
        (adapter as FeishuAdapter).sendPollCard(chatId, pollId, question, options),
      );
    }
  }
  for (const adapter of adapters) {
    images?.registerSender(adapter.id, (chatId, image) => {
      if (adapter.id === 'telegram') {
        return (adapter as TelegramAdapter).sendImage(chatId, image.url);
      }
      if (adapter.id === 'feishu') {
        return (adapter as FeishuAdapter).sendImage(chatId, image);
      }
      return Promise.resolve();
    });
  }

  if (broadcasts) {
    broadcasts.start(
      async (platform, chatId, text) => {
        const adapter = adapters.find((a) => a.id === platform);
        if (!adapter) {
          log.warn({ platform, chatId }, '播报目标平台未启用，丢弃');
          return;
        }
        await adapter.sendTo(chatId, text);
      },
      generate,
    );
  }
  log.info(
    { version: VERSION, platforms: adapters.map((a) => a.id), defaultModel: registry.defaultAlias },
    `moss-bots v${VERSION} 已启动`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
