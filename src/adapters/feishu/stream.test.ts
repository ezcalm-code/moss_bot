import { describe, expect, it } from 'vitest';
import { FeishuSimpleReply, FeishuStreamReply, type FeishuCardApi } from './stream';

function fakeCardApi() {
  const state = {
    cards: [] as string[],
    cardMessages: [] as string[],
    updates: [] as { cardId: string; sequence: number; content: string }[],
    texts: [] as { chatId: string; text: string }[],
    failCreate: false,
    failUpdate: false,
    nextCardId: 1,
  };
  const api: FeishuCardApi = {
    async createCard(cardJson) {
      if (state.failCreate) throw new Error('create failed');
      state.cards.push(cardJson);
      return `card_${state.nextCardId++}`;
    },
    async sendCardMessage(_chatId, cardId) {
      state.cardMessages.push(cardId);
    },
    async updateCard(cardId, sequence, cardJson) {
      if (state.failUpdate) throw new Error('update failed');
      state.updates.push({ cardId, sequence, content: cardJson });
    },
    async sendTextMessage(chatId, text) {
      state.texts.push({ chatId, text });
    },
  };
  return { api, state };
}

const silentLog = { warn: () => {} };

describe('FeishuStreamReply', () => {
  it('首个 delta 创建卡片并发送卡片消息', async () => {
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, { minIntervalMs: 10_000 });
    await reply.append('Hel');
    expect(state.cards).toHaveLength(1);
    expect(state.cardMessages).toEqual(['card_1']);
  });

  it('节流间隔内不重复更新，到点后全量更新（AC4.3）', async () => {
    let now = 0;
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {
      minIntervalMs: 800,
      now: () => now,
    });
    await reply.append('Hel'); // 创建
    now = 400;
    await reply.append('lo');
    expect(state.updates).toHaveLength(0);
    now = 900;
    await reply.append('!');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.sequence).toBe(1); // 飞书要求 sequence 从 1 起，0 触发 300317
    const content = JSON.parse(state.updates[0]?.content ?? '{}') as {
      body: { elements: { content: string }[] };
    };
    expect(content.body.elements[0]?.content).toBe('Hello!');
  });

  it('finish 定稿最终内容', async () => {
    let now = 0;
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {
      minIntervalMs: 800,
      now: () => now,
    });
    await reply.append('abc');
    now = 10_000;
    await reply.finish();
    const last = state.updates.at(-1);
    const content = JSON.parse(last?.content ?? '{}') as {
      body: { elements: { content: string }[] };
    };
    expect(content.body.elements[0]?.content).toBe('abc');
    expect(last?.sequence).toBe(1); // 定稿是首次更新，sequence 从 1 起
  });

  it('卡片创建失败时降级为文本消息', async () => {
    const { api, state } = fakeCardApi();
    state.failCreate = true;
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {});
    await reply.append('Hello');
    await reply.finish();
    expect(state.texts).toEqual([{ chatId: 'oc_1', text: 'Hello' }]);
  });

  it('卡片更新失败在 finish 时仍以文本兜底', async () => {
    const { api, state } = fakeCardApi();
    let now = 0;
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {
      minIntervalMs: 0,
      now: () => now,
    });
    await reply.append('part1');
    state.failUpdate = true;
    now = 10_000;
    await reply.append('part2'); // update 失败被吞
    await reply.finish(); // 仍失败 → 文本兜底
    expect(state.texts).toEqual([{ chatId: 'oc_1', text: 'part1part2' }]);
  });

  it('abort 更新卡片为中断文案（AC4.x 错误路径）', async () => {
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {});
    await reply.append('abc');
    await reply.abort(new Error('boom'));
    const content = JSON.parse(state.updates.at(-1)?.content ?? '{}') as {
      body: { elements: { content: string }[] };
    };
    expect(content.body.elements[0]?.content).toContain('boom');
    expect(state.texts).toHaveLength(0);
  });

  it('abort 在卡片未创建时发送文本', async () => {
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {});
    await reply.abort(new Error('boom'));
    expect(state.texts[0]?.text).toContain('生成中断');
  });

  it('sequence 严格递增且从 1 起（飞书卡片接口约束，300317 回归）', async () => {
    let now = 0;
    const { api, state } = fakeCardApi();
    const reply = new FeishuStreamReply(api, 'oc_1', silentLog, {
      minIntervalMs: 0,
      now: () => now,
    });
    await reply.append('a'); // 创建卡片，不占 sequence
    now += 1000;
    await reply.append('b');
    now += 1000;
    await reply.append('c');
    now += 1000;
    await reply.finish();
    const seqs = state.updates.map((u) => u.sequence);
    expect(seqs).toEqual([1, 2, 3]);
    expect(seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1)).toBe(true);
  });
});

describe('FeishuSimpleReply', () => {
  it('finish 一次性发送全文（AC4.4）', async () => {
    const { api, state } = fakeCardApi();
    const reply = new FeishuSimpleReply(api, 'oc_1', silentLog);
    await reply.append('Hello ');
    await reply.append('world');
    await reply.finish();
    expect(state.texts).toEqual([{ chatId: 'oc_1', text: 'Hello world' }]);
    expect(state.cards).toHaveLength(0);
  });

  it('abort 发送中断文案', async () => {
    const { api, state } = fakeCardApi();
    const reply = new FeishuSimpleReply(api, 'oc_1', silentLog);
    await reply.abort(new Error('boom'));
    expect(state.texts[0]?.text).toContain('生成中断');
  });
});
