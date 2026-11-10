import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import type { IncomingMessage, StreamReplyHandle } from '../adapters/types';
import { loadConfig, loadEnvFile } from '../config/load';
import { getProxyDispatcher } from '../proxy';
import { UserMemoryStore } from '../memory/store';
import { BotCore } from '../core/bot';
import { SessionManager } from '../core/session';
import { buildRegistry } from '../llm/registry';
import { createLogger } from '../log';
import { createAddNoteTool } from '../notes/notes-tool';
import { NotesService } from '../notes/service';
import { NotesStore } from '../notes/store';
import { createReminderTool } from '../reminders/reminder-tool';
import { ReminderService } from '../reminders/service';
import { ReminderStore } from '../reminders/store';
import { BroadcastService, type BroadcastGenerate } from '../broadcasts/service';
import { BroadcastStore } from '../broadcasts/store';
import { createScheduleBroadcastTool } from '../broadcasts/broadcast-tool';
import { createSearchProvider, createToolRunner } from '../tools';
import { FileSessionStore } from '../stores/file';
import { MemorySessionStore } from '../stores/memory';

function cliMessage(text: string): IncomingMessage {
  return {
    platform: 'cli',
    chatId: 'local',
    senderId: 'user',
    senderName: 'User',
    isGroup: false,
    isTargeted: true,
    text,
    attachments: [],
    raw: undefined,
    async reply(t) {
      console.log(t);
    },
    async getAttachmentDataUrls() {
      return [];
    },
    async startStreamReply(): Promise<StreamReplyHandle> {
      return {
        async append(delta) {
          process.stdout.write(delta);
        },
        async finish() {
          process.stdout.write('\n\n');
        },
        async abort(err) {
          console.error(`\n出错了: ${err.message}\n`);
        },
      };
    },
  };
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const log = createLogger(config.log.level);
  const proxyDispatcher = getProxyDispatcher();
  const registry = buildRegistry(config, proxyDispatcher);
  const reminders = new ReminderService(new ReminderStore(join('data', 'reminders'), log), log);
  // 笔记模块需要加密密钥：未配置 NOTES_ENCRYPTION_KEY 时整体不装配（不提供明文模式）
  const notesKey = process.env.NOTES_ENCRYPTION_KEY;
  const notes = notesKey
    ? new NotesService(new NotesStore(join('data', 'notes', 'notes.bin'), notesKey))
    : undefined;
  // 每日播报生成：搜索 + 摘要（REPL 内直接打印）
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
  const tools = createToolRunner(config.tools, proxyDispatcher, [
    createReminderTool({ service: reminders }),
    ...(notes ? [createAddNoteTool({ service: notes })] : []),
    ...(broadcasts ? [createScheduleBroadcastTool({ service: broadcasts })] : []),
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
  });
  // REPL 的提醒投递直接打到终端
  reminders.start(async (_platform, _chatId, text) => {
    console.log(`\n⏰ ${text}\n`);
  });
  if (broadcasts) {
    broadcasts.start(
      async (_platform, _chatId, text) => {
        console.log(`\n📰 ${text}\n`);
      },
      generate,
    );
  }

  const { entry, provider } = registry.resolve();
  console.log(
    `Moss REPL — provider=${provider.id} 默认模型=${entry.alias}(${entry.model}) store=${config.session.store}`,
  );
  console.log('输入内容回车对话；/help 查看命令；exit 或 Ctrl+C 退出。');

  process.on('SIGINT', () => {
    console.log('\n再见');
    process.exit(0);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  // 用事件模式而非 question() 轮询：readline promises 的连续 question 在管道 stdin 下会挂起
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    if (text === 'exit' || text === 'quit') {
      rl.close();
      return;
    }
    chain = chain.then(() => bot.handle(cliMessage(text)));
  });
  rl.on('close', () => {
    void chain
      .catch(() => {})
      .then(() => {
        reminders.stop();
        console.log('\n再见');
        // pino-pretty worker（独立线程）会挂住事件循环，exitCode 软退出永不生效；
        // stdout 回调式退出也不可靠（重定向到 /dev/null 时不触发）。
        // 普通 timer（不 unref）到点硬退，200ms 足够小消息刷出
        setTimeout(() => process.exit(0), 200);
      });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
