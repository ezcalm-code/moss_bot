import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../adapters/types';
import { LlmRegistry } from '../llm/registry';
import type { LLMProvider } from '../llm/types';
import { MemorySessionStore } from '../stores/memory';
import { BotCore } from './bot';
import { builtinCommands, CommandRegistry, parseCommand } from './commands';
import { SessionManager } from './session';

const silentLog = pino({ level: 'silent' });

function fakeProvider(fail = false) {
  const calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  const provider: LLMProvider = {
    id: 'fake',
    async *streamChat(messages, opts) {
      calls.push({
        model: opts.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      if (fail) throw new Error('boom');
      yield 'Hel';
      yield 'lo!';
    },
    async chat() {
      return 'Hello!';
    },
  };
  return { provider, calls };
}

function makeDeps(fail = false) {
  const { provider, calls } = fakeProvider(fail);
  const registry = new LlmRegistry(
    new Map([['xai', provider]]),
    new Map(),
    [
      { alias: 'grok', provider: 'xai', model: 'grok-a' },
      { alias: 'ds-chat', provider: 'xai', model: 'ds-b' },
    ],
    'grok',
  );
  const sessions = new SessionManager(new MemorySessionStore(), 6);
  const bot = new BotCore({
    registry,
    sessions,
    systemPrompt: 'SYS',
    personaName: 'Moss',
    log: silentLog,
  });
  return { bot, sessions, calls };
}

function fakeMsg(text: string, extra?: Partial<IncomingMessage>) {
  const state = {
    replies: [] as string[],
    appended: [] as string[],
    finished: false,
    aborted: null as Error | null,
  };
  const msg: IncomingMessage = {
    platform: 'telegram',
    chatId: '1',
    senderId: 'u1',
    senderName: 'Alice',
    isGroup: false,
    isTargeted: true,
    text,
    attachments: [],
    raw: undefined,
    async reply(t) {
      state.replies.push(t);
    },
    async startStreamReply() {
      return {
        async append(d) {
          state.appended.push(d);
        },
        async finish() {
          state.finished = true;
        },
        async abort(e) {
          state.aborted = e;
        },
      };
    },
    ...extra,
  };
  return { msg, state };
}

describe('parseCommand', () => {
  it.each([
    ['/help', { name: 'help', args: '' }],
    ['/model ds-chat', { name: 'model', args: 'ds-chat' }],
    ['/model@grok_bot ds-chat', { name: 'model', args: 'ds-chat' }],
    ['/MODELS', { name: 'models', args: '' }],
    ['/reset   ', { name: 'reset', args: '' }],
  ])('%s → %j', (input, expected) => {
    expect(parseCommand(input)).toEqual(expected);
  });

  it.each(['hello', '/', '/ model', '@bot hi'])('%s 不是命令', (input) => {
    expect(parseCommand(input)).toBeUndefined();
  });
});

describe('CommandRegistry', () => {
  it('内置命令表只暴露 4 个可见命令（/start 不可见）', () => {
    const registry = new CommandRegistry(builtinCommands());
    const menu = registry
      .menu()
      .map((m) => m.name)
      .sort();
    expect(menu).toEqual(['help', 'model', 'models', 'reset']);
  });
});

describe('BotCore', () => {
  it('群聊非 targeted 消息被忽略', async () => {
    const { bot } = makeDeps();
    const { msg, state } = fakeMsg('hello', { isGroup: true, isTargeted: false });
    await bot.handle(msg);
    expect(state.replies).toHaveLength(0);
    expect(state.appended).toHaveLength(0);
  });

  it('普通消息走 LLM 流式回复并回写历史', async () => {
    const { bot, sessions, calls } = makeDeps();
    const { msg, state } = fakeMsg('你好');
    await bot.handle(msg);
    expect(state.appended).toEqual(['Hel', 'lo!']);
    expect(state.finished).toBe(true);
    const session = await sessions.get('telegram', '1');
    expect(session.history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'Hello!' },
    ]);
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(calls[0]?.model).toBe('grok-a');
  });

  it('群聊 user 消息拼 senderName 前缀', async () => {
    const { bot, sessions } = makeDeps();
    const { msg } = fakeMsg('大家好', { isGroup: true, isTargeted: true, senderName: 'Alice' });
    await bot.handle(msg);
    const session = await sessions.get('telegram', '1');
    expect(session.history[0]?.content).toBe('Alice: 大家好');
  });

  it('/reset 清空历史，命令本身不进历史', async () => {
    const { bot, sessions } = makeDeps();
    await bot.handle(fakeMsg('你好').msg);
    const r = fakeMsg('/reset');
    await bot.handle(r.msg);
    expect(r.state.replies.join('\n')).toContain('已清空');
    const session = await sessions.get('telegram', '1');
    expect(session.history).toEqual([]);
    expect(session.modelAlias).toBeUndefined();
  });

  it('/model 切换后下一轮使用新模型', async () => {
    const { bot, calls } = makeDeps();
    const r1 = fakeMsg('/model ds-chat');
    await bot.handle(r1.msg);
    expect(r1.state.replies.join('\n')).toContain('已切换模型');
    await bot.handle(fakeMsg('hi').msg);
    expect(calls[0]?.model).toBe('ds-b');
  });

  it('未知命令收到提示', async () => {
    const { bot } = makeDeps();
    const { msg, state } = fakeMsg('/nope');
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('未知的命令');
  });

  it('LLM 失败时调用 abort 且不回写历史', async () => {
    const { bot, sessions } = makeDeps(true);
    const { msg, state } = fakeMsg('hi');
    await bot.handle(msg);
    expect(state.aborted?.message).toBe('boom');
    expect(state.finished).toBe(false);
    const session = await sessions.get('telegram', '1');
    expect(session.history).toEqual([]);
  });

  it('非文本消息提示暂不支持', async () => {
    const { bot } = makeDeps();
    const { msg, state } = fakeMsg('', { attachments: [{ type: 'image' }] });
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('暂时只支持文字');
  });
});
