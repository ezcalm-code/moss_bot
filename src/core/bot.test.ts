import pino from 'pino';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '../adapters/types';
import { LlmRegistry } from '../llm/registry';
import { UserMemoryStore } from '../memory/store';
import type { LLMProvider, StreamEvent } from '../llm/types';
import { ToolRunner } from '../tools';
import { createWebSearchTool } from '../tools/web-search';
import type { SearchProvider } from '../tools/web-search/tavily';
import { MemorySessionStore } from '../stores/memory';
import { BotCore } from './bot';
import { builtinCommands, CommandRegistry, parseCommand } from './commands';
import { SessionManager } from './session';

const silentLog = pino({ level: 'silent' });

const text = (t: string): StreamEvent => ({ type: 'text', text: t });
const finish = (reason = 'stop'): StreamEvent => ({ type: 'finish', reason });
const toolCallEvent = (id: string, args: string, name = 'web_search'): StreamEvent => ({
  type: 'tool_call',
  call: { id, name, arguments: args },
});
const defaultEvents = (): StreamEvent[] => [text('Hel'), text('lo!'), finish('stop')];

function stubToolRunner(
  result: string,
  onExec?: () => void,
  name = 'web_search',
): ToolRunner {
  return new ToolRunner([
    {
      name,
      description: 'fake tool',
      parameters: { type: 'object', properties: {} },
      async exec() {
        onExec?.();
        return result;
      },
    },
  ]);
}

interface CapturedMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

function makeDeps(memory?: UserMemoryStore, tools?: ToolRunner, opts?: { holdFirst?: boolean }) {
  const calls: { model: string; hasTools: boolean; messages: CapturedMessage[] }[] = [];
  const holdFirst = opts?.holdFirst ?? false;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const providerState: {
    fail: boolean;
    failStatus?: number;
    failStatusOnce?: number;
    failOnCall?: { n: number; status: number };
    script: StreamEvent[][];
  } = { fail: false, script: [] };
  const throwIfFail = (callIndex: number): void => {
    if (providerState.fail) throw new Error('boom');
    if (providerState.failStatus !== undefined) {
      throw Object.assign(new Error('api rejected'), { status: providerState.failStatus });
    }
    if (providerState.failStatusOnce !== undefined) {
      const status = providerState.failStatusOnce;
      providerState.failStatusOnce = undefined;
      throw Object.assign(new Error('api rejected'), { status });
    }
    if (providerState.failOnCall && callIndex >= providerState.failOnCall.n) {
      throw Object.assign(new Error('api rejected'), { status: providerState.failOnCall.status });
    }
  };
  const capture = (
    messages: readonly { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[],
  ): CapturedMessage[] =>
    messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
    }));
  const provider: LLMProvider = {
    id: 'fake',
    async *streamChat(messages, opts) {
      const callIndex = calls.push({
        model: opts.model,
        hasTools: Boolean(opts.tools?.length),
        messages: capture(messages),
      });
      throwIfFail(callIndex);
      if (holdFirst && callIndex === 1) await firstGate;
      const events =
        providerState.script.length > 0
          ? (providerState.script.shift() as StreamEvent[])
          : defaultEvents();
      for (const evt of events) yield evt;
    },
    async chat(messages, opts) {
      const callIndex = calls.push({ model: opts.model, hasTools: false, messages: capture(messages) });
      throwIfFail(callIndex);
      return 'Hello!';
    },
  };
  const registry = new LlmRegistry(
    new Map([['xai', provider]]),
    new Map(),
    [
      { alias: 'grok', provider: 'xai', model: 'grok-a' },
      { alias: 'ds-chat', provider: 'xai', model: 'ds-b' },
      { alias: 'plain', provider: 'xai', model: 'plain-m', supportsTools: false },
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
    tools,
  });
  return {
    bot,
    registry,
    sessions,
    calls,
    releaseFirst: () => releaseFirst?.(),
    setFail: (v: boolean) => (providerState.fail = v),
    setFailWithStatus: (status: number) => (providerState.failStatus = status),
    setFailWithStatusOnce: (status: number) => (providerState.failStatusOnce = status),
    setFailOnCall: (n: number, status: number) => (providerState.failOnCall = { n, status }),
    clearFail: () => {
      providerState.fail = false;
      providerState.failStatus = undefined;
      providerState.failStatusOnce = undefined;
      providerState.failOnCall = undefined;
    },
    setScript: (script: StreamEvent[][]) => (providerState.script = script),
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
  it('内置命令表暴露 17 个可见命令（/start 不可见）', () => {
    const registry = new CommandRegistry(builtinCommands());
    const menu = registry
      .menu()
      .map((m) => m.name)
      .sort();
    expect(menu).toEqual([
      'broadcast',
      'broadcasts',
      'compact',
      'delnote',
      'forget',
      'help',
      'memory',
      'model',
      'models',
      'notes',
      'poll',
      'remember',
      'remind',
      'reminders',
      'reset',
      'unbroadcast',
      'unremind',
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
  it('targeted 空文本（只 @ / 只回复没正文）回轻量搭话不装死', async () => {
    const { bot } = makeDeps();
    const { msg, state } = fakeMsg('', { isGroup: true, isTargeted: true });
    await bot.handle(msg);
    expect(state.replies.join('\n')).toContain('在的在的');
  });

  it('回复消息时带上被回复内容作为引用上下文', async () => {
    const { bot, calls } = makeDeps();
    const { msg } = fakeMsg('针对这个你怎么看', {
      getReplyContext: async () => '被引用的原文内容',
    });
    await bot.handle(msg);
    const sent = String(calls[0]?.messages.at(-1)?.content);
    expect(sent).toContain('[引用的消息]');
    expect(sent).toContain('被引用的原文内容');
    expect(sent).toContain('针对这个你怎么看');
  });

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
    expect(String(calls[0]?.messages[0]?.content)).toMatch(/^SYS/); // system prompt 含日期注入，前缀为 persona
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

  it('system prompt 注入当天日期（模型无时间感知）', async () => {
    const { bot, calls } = makeDeps();
    await bot.handle(fakeMsg('你好').msg);
    const sys = String(calls[0]?.messages[0]?.content ?? '');
    expect(sys).toContain('现在的本地时间是');
    expect(sys).toContain(`（周${'日一二三四五六'[new Date().getDay()]}）`);
  });

  it('无画像时不注入（messages[0] 保持纯 persona）', async () => {
    const { bot, calls } = makeDeps(newMemory());
    await bot.handle(fakeMsg('你好').msg);
    expect(String(calls[0]?.messages[0]?.content)).toMatch(/^SYS/);
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
    expect(String(calls[0]?.messages[0]?.content)).toMatch(/^SYS/);
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

  it('菜单含 17 个可见命令', () => {
    const registry = new CommandRegistry(builtinCommands());
    expect(
      registry
        .menu()
        .map((m) => m.name)
        .sort(),
    ).toEqual([
      'broadcast',
      'broadcasts',
      'compact',
      'delnote',
      'forget',
      'help',
      'memory',
      'model',
      'models',
      'notes',
      'poll',
      'remember',
      'remind',
      'reminders',
      'reset',
      'unbroadcast',
      'unremind',
    ]);
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

describe('vision 回复取图', () => {
  it('回复图片消息（本条纯文字）也能取到被回复的图', async () => {
    const { bot, calls } = makeDeps();
    const { msg } = fakeMsg('这是什么', {
      dataUrls: ['data:image/jpeg;base64,aGVsbG8='], // 适配器反查被回复消息后返回图片
    });
    await bot.handle(msg);
    const sent = calls[0]?.messages.at(-1)?.content;
    expect(Array.isArray(sent)).toBe(true); // 多模态请求发出
    const parts = sent as { type: string }[];
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('无图纯文字时 getAttachmentDataUrls 也被调用但不影响文本流程', async () => {
    const { bot, calls } = makeDeps();
    await bot.handle(fakeMsg('你好').msg);
    const sent = calls[0]?.messages.at(-1)?.content;
    expect(sent).toBe('你好'); // 纯文本形态
  });
});

describe('工具调用循环', () => {
  it('多轮循环：工具结果回传后第二轮作答，历史只留最终一对', async () => {
    const { bot, calls, sessions, setScript } = makeDeps(
      undefined,
      stubToolRunner('搜索结果：今天晴，12~20°C'),
    );
    setScript([[toolCallEvent('call_1', '{"query":"北京天气"}'), finish('tool_calls')]]);
    const { msg, state } = fakeMsg('今天天气怎么样');
    await bot.handle(msg);

    expect(calls).toHaveLength(2); // 第一轮 tool_call + 第二轮作答
    expect(calls[0]?.hasTools).toBe(true);
    expect(calls[1]?.hasTools).toBe(true);
    const second = calls[1]?.messages ?? [];
    expect(second.at(-2)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"北京天气"}' }],
    });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '搜索结果：今天晴，12~20°C',
    });
    expect(state.finished).toBe(true);
    expect(state.appended).toEqual(['Hel', 'lo!']); // 第二轮文本照常流式
    const session = await sessions.get('telegram', '1');
    expect(session.history).toEqual([
      { role: 'user', content: '今天天气怎么样' },
      { role: 'assistant', content: 'Hello!' }, // 工具中间轮不进历史
    ]);
  });

  it('5 轮上限：第 6 次请求起不带 tools 强制作答', async () => {
    const { bot, calls, sessions, setScript } = makeDeps(undefined, stubToolRunner('r'));
    const endless = (): StreamEvent[] => [toolCallEvent('c', '{"query":"q"}'), finish('tool_calls')];
    setScript([endless(), endless(), endless(), endless(), endless()]);
    const { msg, state } = fakeMsg('搜');
    await bot.handle(msg);
    expect(calls).toHaveLength(6); // 5 轮带 tools + 收尾 1 轮不带
    expect(calls.slice(0, 5).every((c) => c.hasTools)).toBe(true);
    expect(calls[5]?.hasTools).toBe(false);
    expect(state.finished).toBe(true);
    expect((await sessions.get('telegram', '1')).history).toHaveLength(2);
  });

  it('finish=tool_calls 但无 calls 时视为结束，不再执行工具', async () => {
    const { bot, calls, setScript } = makeDeps(undefined, stubToolRunner('r'));
    setScript([[finish('tool_calls')], [text('direct'), finish('stop')]]);
    const { msg, state } = fakeMsg('hi');
    await bot.handle(msg);
    expect(calls).toHaveLength(1); // 第一轮即结束，防死循环
    expect(state.finished).toBe(true);
  });

  it('首轮带工具被 4xx 拒：markNoTools 并透明降级重试一次', async () => {
    const { bot, registry, calls, setFailWithStatusOnce, clearFail } = makeDeps(
      undefined,
      stubToolRunner('r'),
    );
    setFailWithStatusOnce(400);
    const { msg, state } = fakeMsg('hi');
    await bot.handle(msg);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.hasTools).toBe(true);
    expect(calls[1]?.hasTools).toBe(false); // 降级重试不带 tools
    expect(state.finished).toBe(true);
    expect(registry.isToolsBlocked('grok-a')).toBe(true);

    // 标记生效：后续请求从一开始就不带 tools
    clearFail();
    await bot.handle(fakeMsg('hi2').msg);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.hasTools).toBe(false);
  });

  it('后续轮 4xx 不降级，直接 abort', async () => {
    const { bot, calls, setScript, setFailOnCall } = makeDeps(undefined, stubToolRunner('r'));
    setScript([[toolCallEvent('c1', '{"query":"q"}'), finish('tool_calls')]]);
    setFailOnCall(2, 400); // 第 2 次请求（工具轮之后）才失败
    const { msg, state } = fakeMsg('hi');
    await bot.handle(msg);
    expect(calls).toHaveLength(2);
    expect(state.finished).toBe(false);
    expect(state.aborted?.message).toContain('api rejected');
  });

  it('静态 supportsTools:false 的模型不带 tools', async () => {
    const { bot, calls } = makeDeps(undefined, stubToolRunner('r'));
    await bot.handle(fakeMsg('/model plain').msg);
    await bot.handle(fakeMsg('hi').msg);
    expect(calls.at(-1)?.hasTools).toBe(false);
  });

  it('未注入 ToolRunner 时所有请求不带 tools', async () => {
    const { bot, calls } = makeDeps();
    await bot.handle(fakeMsg('hi').msg);
    expect(calls[0]?.hasTools).toBe(false);
  });

  it('带图轮也挂工具（模仿生图依赖同轮看图+画图）', async () => {
    const { bot, calls } = makeDeps(undefined, stubToolRunner('r'));
    const { msg } = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: ['data:image/jpeg;base64,aGVsbG8='],
    });
    await bot.handle(msg);
    expect(calls[0]?.hasTools).toBe(true);
  });

  it('带图轮首轮 4xx：透明去工具重试成功（不标视觉也不标工具）', async () => {
    const { bot, calls, registry, setFailWithStatusOnce } = makeDeps(
      undefined,
      stubToolRunner('r'),
    );
    setFailWithStatusOnce(400);
    const { msg, state } = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: ['data:image/jpeg;base64,aGVsbG8='],
    });
    await bot.handle(msg);
    expect(calls).toHaveLength(2); // 带图带工具 → 去工具重试
    expect(calls[0]?.hasTools).toBe(true);
    expect(calls[1]?.hasTools).toBe(false);
    expect(calls[1]?.messages.at(-1)).toMatchObject({ role: 'user' }); // 图保留在重试请求里
    expect(state.finished).toBe(true);
    expect(registry.isToolsBlocked('grok-a')).toBe(false); // 归因未定，不标工具位
    expect(registry.isVisionBlocked('grok-a')).toBe(false); // 重试成功，不标视觉位
  });

  it('带图轮去工具重试仍 4xx：判视觉问题并标记', async () => {
    const { bot, calls, registry, setFailWithStatus } = makeDeps(
      undefined,
      stubToolRunner('r'),
    );
    setFailWithStatus(400); // 两次都拒
    const { msg, state } = fakeMsg('这是什么', {
      attachments: [{ type: 'image' }],
      dataUrls: ['data:image/jpeg;base64,aGVsbG8='],
    });
    await bot.handle(msg);
    expect(calls).toHaveLength(2);
    expect(state.aborted?.message).toContain('不支持');
    expect(registry.isVisionBlocked('grok-a')).toBe(true);
  });

  it('冷却贯穿 bot：跨轮（两次用户消息）第二次搜索被冷却拦截', async () => {
    const searchCalls: string[] = [];
    const provider: SearchProvider = {
      id: 'fake',
      async search(query) {
        searchCalls.push(query);
        return [{ title: 'T', url: 'https://u', content: 'C' }];
      },
    };
    let t = 0;
    const tools = new ToolRunner([
      createWebSearchTool({ provider, maxResults: 3, cooldownMinutes: 5, now: () => t }),
    ]);
    const { bot, calls, setScript } = makeDeps(undefined, tools);
    setScript([
      [toolCallEvent('c1', '{"query":"q1"}'), finish('tool_calls')],
      [text('第一轮答完'), finish('stop')],
      [toolCallEvent('c2', '{"query":"q2"}'), finish('tool_calls')],
    ]);
    await bot.handle(fakeMsg('搜一下').msg); // 第一轮：搜索成功
    expect(searchCalls).toEqual(['q1']);
    t += 1000;
    await bot.handle(fakeMsg('再搜一下').msg); // 第二轮（新 turnId）→ 冷却拦截
    expect(searchCalls).toEqual(['q1']); // 搜索源只被调一次
    const cooldownMsg = calls[3]?.messages.at(-1) as { role: string; content: string };
    expect(cooldownMsg?.role).toBe('tool');
    expect(cooldownMsg?.content).toContain('冷却');
  });

  it('同轮 agent 连招：同一轮内第二次搜索放行', async () => {
    const searchCalls: string[] = [];
    const provider: SearchProvider = {
      id: 'fake',
      async search(query) {
        searchCalls.push(query);
        return [{ title: 'T', url: 'https://u', content: 'C' }];
      },
    };
    const t = 0;
    const tools = new ToolRunner([
      createWebSearchTool({ provider, maxResults: 3, cooldownMinutes: 5, now: () => t }),
    ]);
    const { bot, calls, setScript } = makeDeps(undefined, tools);
    setScript([
      [toolCallEvent('c1', '{"query":"q1"}'), finish('tool_calls')],
      [toolCallEvent('c2', '{"query":"q2"}'), finish('tool_calls')],
    ]);
    await bot.handle(fakeMsg('搜两轮').msg); // 同一轮内连搜两次
    expect(searchCalls).toEqual(['q1', 'q2']); // 都放行
    expect(calls).toHaveLength(3); // 两轮工具 + 收尾作答
  });

  it('带工具的多轮结束后 extractMemory 照常发生', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-mem-tool-'));
    try {
      const memory = new UserMemoryStore(dir);
      const { bot, calls, setScript } = makeDeps(memory, stubToolRunner('搜索结果'));
      setScript([[toolCallEvent('c1', '{"query":"q"}'), finish('tool_calls')]]);
      await bot.handle(fakeMsg('搜一下').msg);
      await vi.waitFor(async () => {
        expect(await memory.load('telegram:u1')).toBe('Hello!');
      });
      expect(calls).toHaveLength(3); // 2 次聊天 + 1 次提取（chat，无 tools）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('read_url：模型读链接后第二轮带上正文', async () => {
    const tools = stubToolRunner('[链接] https://a\n\n页面正文内容', undefined, 'read_url');
    const { bot, calls, setScript } = makeDeps(undefined, tools);
    setScript([
      [toolCallEvent('r1', '{"url":"https://a"}', 'read_url'), finish('tool_calls')],
    ]);
    await bot.handle(fakeMsg('https://a 这篇讲了什么').msg);
    expect(calls).toHaveLength(2);
    expect((calls[1]?.messages ?? []).at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'r1',
      content: '[链接] https://a\n\n页面正文内容',
    });
  });
});

describe('会话消息排队', () => {
  it('同会话严格串行：后一条等前一条完成才进 LLM', async () => {
    const { bot, calls, releaseFirst } = makeDeps(undefined, undefined, { holdFirst: true });
    const p1 = bot.handle(fakeMsg('第一条', { chatId: 'q1' }).msg);
    const p2 = bot.handle(fakeMsg('第二条', { chatId: 'q1' }).msg);
    await vi.waitFor(() => expect(calls).toHaveLength(1)); // 第一条已进 LLM
    releaseFirst();
    expect(calls).toHaveLength(1); // 第二条仍在排队，未进 LLM
    await Promise.all([p1, p2]);
    expect(calls).toHaveLength(2);
    // 第二条请求的历史里已含第一条的回答 → 顺序得到保证
    expect(
      (calls[1]?.messages ?? []).some((m) => m.role === 'assistant' && m.content === 'Hello!'),
    ).toBe(true);
  });

  it('不同会话并行互不阻塞', async () => {
    const { bot, calls, releaseFirst } = makeDeps(undefined, undefined, { holdFirst: true });
    const p1 = bot.handle(fakeMsg('A', { chatId: 'qa' }).msg);
    await bot.handle(fakeMsg('B', { chatId: 'qb' }).msg); // 不等 A 的 gate，直接完成
    expect(calls).toHaveLength(2);
    releaseFirst();
    await p1;
  });

  it('排队深度达到上限后丢弃新消息', async () => {
    const { bot, calls, releaseFirst } = makeDeps(undefined, undefined, { holdFirst: true });
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 6; i++) {
      pending.push(bot.handle(fakeMsg(`m${i}`, { chatId: 'qf' }).msg));
    }
    await vi.waitFor(() => expect(calls).toHaveLength(1)); // 第一条已进 LLM
    expect(calls).toHaveLength(1); // 第 6 条在入队前即被丢弃
    releaseFirst();
    await Promise.all(pending);
    expect(calls).toHaveLength(5);
  });

  it('队清空后状态回收，新消息正常处理', async () => {
    const { bot, calls, releaseFirst } = makeDeps(undefined, undefined, { holdFirst: true });
    const p1 = bot.handle(fakeMsg('占位', { chatId: 'qr' }).msg);
    const p2 = bot.handle(fakeMsg('排队', { chatId: 'qr' }).msg);
    releaseFirst();
    await Promise.all([p1, p2]);
    await bot.handle(fakeMsg('恢复', { chatId: 'qr' }).msg);
    expect(calls.filter((c) => c.hasTools === false)).toHaveLength(3);
  });
});
