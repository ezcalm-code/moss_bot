import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '../adapters/types';
import { LlmRegistry } from '../llm/registry';
import { UserMemoryStore } from '../memory/store';
import type { LLMProvider } from '../llm/types';
import { MemorySessionStore } from '../stores/memory';
import { BotCore } from './bot';
import { builtinCommands, CommandRegistry, parseCommand } from './commands';
import { SessionManager } from './session';

const silentLog = pino({ level: 'silent' });

function makeDeps(memory?: UserMemoryStore) {
  const calls: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const providerState: { fail: boolean; failStatus?: number } = { fail: false };
  const throwIfFail = (): void => {
    if (providerState.fail) throw new Error('boom');
    if (providerState.failStatus !== undefined) {
      throw Object.assign(new Error('api rejected'), { status: providerState.failStatus });
    }
  };
  const provider: LLMProvider = {
    id: 'fake',
    async *streamChat(messages, opts) {
      calls.push({
        model: opts.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      throwIfFail();
      yield 'Hel';
      yield 'lo!';
    },
    async chat(messages, opts) {
      calls.push({
        model: opts.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      throwIfFail();
      return 'Hello!';
    },
  };
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
    memory,
  });
  return {
    bot,
    sessions,
    calls,
    setFail: (v: boolean) => (providerState.fail = v),
    setFailWithStatus: (status: number) => (providerState.failStatus = status),
  };
}

function fakeMsg(text: string, extra?: Partial<IncomingMessage> & { dataUrls?: string[] }) {
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
    async getAttachmentDataUrls() {
      return extra?.dataUrls ?? [];
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
  it('内置命令表暴露 8 个可见命令（/start 不可见）', () => {
    const registry = new CommandRegistry(builtinCommands());
    const menu = registry
      .menu()
      .map((m) => m.name)
      .sort();
    expect(menu).toEqual([
      'compact',
      'forget',
      'help',
      'memory',
      'model',
      'models',
      'remember',
      'reset',
    ]);
  });
});

describe('/compact', () => {
  it('压缩后历史替换为单条摘要消息，摘要 prompt 以用户内容为主线（AC compact-1）', async () => {
    const { bot, sessions, calls } = makeDeps();
    await bot.handle(fakeMsg('我叫小明，在折腾一个爬虫项目').msg);
    await bot.handle(fakeMsg('好的记住啦').msg);
    const before = (await sessions.get('telegram', '1')).history.length;
    expect(before).toBe(4);

    const { msg, state } = fakeMsg('/compact');
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('已压缩');

    const session = await sessions.get('telegram', '1');
    expect(session.history).toHaveLength(1);
    expect(session.history[0]?.role).toBe('user');
    expect(session.history[0]?.content).toContain('压缩摘要');
    expect(session.history[0]?.content).toContain('Hello!');

    // 摘要 prompt 应包含原对话内容（calls 最后一次是 compact 的摘要调用）
    const prompt = calls[calls.length - 1]?.messages[0]?.content ?? '';
    expect(prompt).toContain('用户：我叫小明，在折腾一个爬虫项目');
    expect(prompt).toContain('助手：Hello!');
  });

  it('空历史时提示无需压缩', async () => {
    const { bot, sessions } = makeDeps();
    const { msg, state } = fakeMsg('/compact');
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('没什么可压缩');
    expect((await sessions.get('telegram', '1')).history).toHaveLength(0);
  });

  it('LLM 失败时提示且原历史保持不变', async () => {
    const { bot, sessions, setFail } = makeDeps();
    await bot.handle(fakeMsg('你好').msg);
    const before = (await sessions.get('telegram', '1')).history.slice();
    setFail(true);
    const { msg, state } = fakeMsg('/compact');
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('压缩失败');
    expect((await sessions.get('telegram', '1')).history).toEqual(before);
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
    const { bot, sessions, setFail } = makeDeps();
    setFail(true);
    const { msg, state } = fakeMsg('hi');
    await bot.handle(msg);
    expect(state.aborted?.message).toBe('boom');
    expect(state.finished).toBe(false);
    const session = await sessions.get('telegram', '1');
    expect(session.history).toEqual([]);
  });

  it('非图片附件（audio）提示暂不支持', async () => {
    const { bot } = makeDeps();
    const { msg, state } = fakeMsg('', { attachments: [{ type: 'audio' }] });
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('暂时只支持文字');
  });
});

describe('memory', () => {
  const tmpDirs: string[] = [];

  function newMemory(): UserMemoryStore {
    const dir = mkdtempSync(join(tmpdir(), 'moss-mem-test-'));
    tmpDirs.push(dir);
    return new UserMemoryStore(dir);
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('已有画像时注入 system prompt（messages[0] 含已知信息）', async () => {
    const memory = newMemory();
    await memory.save('telegram:u1', '- 用户叫小明');
    const { bot, calls } = makeDeps(memory);
    await bot.handle(fakeMsg('你好').msg);
    const sys = calls[0]?.messages[0]?.content ?? '';
    expect(sys).toContain('SYS');
    expect(sys).toContain('已知信息');
    expect(sys).toContain('- 用户叫小明');
  });

  it('无画像时不注入（messages[0] 保持纯 persona）', async () => {
    const { bot, calls } = makeDeps(newMemory());
    await bot.handle(fakeMsg('你好').msg);
    expect(calls[0]?.messages[0]?.content).toBe('SYS');
  });

  it('回复后后台提取并写盘（vi.waitFor）', async () => {
    const memory = newMemory();
    const { bot, calls, sessions } = makeDeps(memory);
    await bot.handle(fakeMsg('我叫小明').msg);
    await vi.waitFor(async () => {
      expect(await memory.load('telegram:u1')).toBe('Hello!');
    });
    // 提取调用发生了：聊天(streamChat) 1 次 + 提取(chat) 1 次
    expect(calls.length).toBe(2);
    const session = await sessions.get('telegram', '1');
    expect(session.history).toHaveLength(2); // 对话本身不受影响
  });

  it('memory 未开启时无注入也无提取', async () => {
    const { bot, calls } = makeDeps();
    await bot.handle(fakeMsg('你好').msg);
    expect(calls[0]?.messages[0]?.content).toBe('SYS');
    expect(calls.length).toBe(1); // 只有聊天调用，无提取
  });
});

describe('/remember /memory /forget', () => {
  const tmpDirs: string[] = [];

  function makeWithMemory() {
    const dir = mkdtempSync(join(tmpdir(), 'moss-mem-cmd-'));
    tmpDirs.push(dir);
    return makeDeps(new UserMemoryStore(dir));
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('/remember 追加事实，/memory 查看，/forget 清除', async () => {
    const { bot } = makeWithMemory();
    await bot.handle(fakeMsg('/remember 我对花生过敏').msg);
    await bot.handle(fakeMsg('/remember 我在杭州工作').msg);

    const view = fakeMsg('/memory');
    await bot.handle(view.msg);
    const shown = view.state.replies.join('\n');
    expect(shown).toContain('我对花生过敏');
    expect(shown).toContain('我在杭州工作');

    await bot.handle(fakeMsg('/forget').msg);
    const gone = fakeMsg('/memory');
    await bot.handle(gone.msg);
    expect(gone.state.replies.join('\n')).toContain('还没有关于你的记忆');
  });

  it('/remember 无参数时给出用法提示', async () => {
    const { bot } = makeWithMemory();
    const { msg, state } = fakeMsg('/remember');
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('想让我记什么');
  });

  it('菜单含 8 个可见命令', () => {
    const registry = new CommandRegistry(builtinCommands());
    expect(
      registry
        .menu()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['compact', 'forget', 'help', 'memory', 'model', 'models', 'remember', 'reset']);
  });
});

describe('memory 跨场景共享', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('群里记的画像，私聊（不同 chatId、相同 senderId）同样注入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-mem-x-'));
    tmpDirs.push(dir);
    const { bot, calls } = makeDeps(new UserMemoryStore(dir));
    const sender = { senderId: 'u9' };

    // 群聊（chatId=群号）中告知身份 → 后台提取落盘到 telegram:u9
    await bot.handle(
      fakeMsg('我是做后端开发的', { isGroup: true, chatId: 'group-1', ...sender }).msg,
    );
    await vi.waitFor(async () => {
      expect(await memoryHas(dir, 'telegram:u9')).toBe(true);
    });

    // 私聊（chatId=私聊号，同一 senderId）提问 → 画像应注入 system prompt
    // （提问本身又会触发新一轮提取调用，所以用 find 找注入了画像的聊天调用）
    const pm = fakeMsg('我是做什么的？', { chatId: 'private-9', ...sender });
    await bot.handle(pm.msg);
    const chatCall = calls.find((c) => String(c.messages[0]?.content).includes('已知信息'));
    expect(chatCall).toBeTruthy();
    expect(chatCall?.messages[0]?.content).toContain('Hello!'); // fake provider 的提取结果即画像内容
    expect(pm.state.appended.length).toBeGreaterThan(0);
  });
});

async function memoryHas(dir: string, key: string): Promise<boolean> {
  return (await new UserMemoryStore(dir).load(key)) !== '';
}

describe('vision（图片理解）', () => {
  const DATA_URL = 'data:image/jpeg;base64,aGVsbG8=';

  it('带图消息走多模态数组请求，历史只留占位', async () => {
    const { bot, calls, sessions } = makeDeps();
    const { msg, state } = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: [DATA_URL],
    });
    await bot.handle(msg);
    const sent = calls[0]?.messages.at(-1)?.content;
    expect(Array.isArray(sent)).toBe(true);
    const parts = sent as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]?.type).toBe('text');
    expect(parts[1]?.type).toBe('image_url');
    expect(parts[1]?.image_url?.url).toBe(DATA_URL);
    expect(state.appended).toEqual(['Hel', 'lo!']);

    const session = await sessions.get('telegram', '1');
    expect(session.history[0]?.content).toBe('[图片] 这是什么'); // base64 不进历史
  });

  it('纯图无文字也能触发', async () => {
    const { bot, calls } = makeDeps();
    const { msg } = fakeMsg('', {
      attachments: [{ type: 'image' }],
      dataUrls: [DATA_URL],
    });
    await bot.handle(msg);
    expect(calls.length).toBe(1);
  });

  it('带图请求被 4xx 拒绝 → 提示换模型并记入缓存', async () => {
    const { bot, calls, setFailWithStatus } = makeDeps();
    const first = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: [DATA_URL],
    });
    setFailWithStatus(400);
    await bot.handle(first.msg);
    expect(first.state.aborted?.message).toContain('不支持');
    expect(first.state.finished).toBe(false);

    // 缓存生效：再次发图直接提示，不再调用 LLM
    const callsBefore = calls.length;
    const second = fakeMsg('再看看这张', {
      attachments: [{ type: 'image' }],
      dataUrls: [DATA_URL],
    });
    await bot.handle(second.msg);
    expect(second.state.replies.join('\n')).toContain('不支持');
    expect(calls.length).toBe(callsBefore);
  });

  it('5xx 不误判为不支持（仍走普通错误文案）', async () => {
    const { bot, setFailWithStatus } = makeDeps();
    setFailWithStatus(500);
    const { msg, state } = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: [DATA_URL],
    });
    await bot.handle(msg);
    expect(state.aborted?.message).toContain('api rejected'); // 普通 abort 文案
    expect(state.aborted?.message).not.toContain('不支持');
  });
});
