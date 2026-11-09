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
import { createReminderTool } from '../reminders/reminder-tool';
import { ReminderService } from '../reminders/service';
import { ReminderStore } from '../reminders/store';
import { createToolRunner } from '../tools';
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
  const tools = createToolRunner(config.tools, proxyDispatcher, [
    createReminderTool({ service: reminders }),
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
    reminders,
  });
  // REPL 的提醒投递直接打到终端
  reminders.start(async (_platform, _chatId, text) => {
    console.log(`\n⏰ ${text}\n`);
  });

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
