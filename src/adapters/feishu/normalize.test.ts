import { describe, expect, it } from 'vitest';
import { buildStreamingCard, normalizeFeishuMessage, type FeishuEventLike } from './normalize';

const BOT_OPEN_ID = 'ou_bot123';

function base(overrides: Partial<FeishuEventLike> = {}): FeishuEventLike {
  return {
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
    },
    sender: { sender_id: { open_id: 'ou_user1' } },
    ...overrides,
  };
}

describe('normalizeFeishuMessage', () => {
  it('p2p 文本消息恒 targeted', () => {
    const m = normalizeFeishuMessage(base(), BOT_OPEN_ID);
    expect(m.isGroup).toBe(false);
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('你好');
    expect(m.chatId).toBe('oc_chat1');
    expect(m.senderId).toBe('ou_user1');
  });

  it('群聊未 @bot 不触发', () => {
    const m = normalizeFeishuMessage(
      base({
        message: {
          message_id: 'om_2',
          chat_id: 'oc_g1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '大家聊聊' }),
        },
      }),
      BOT_OPEN_ID,
    );
    expect(m.isGroup).toBe(true);
    expect(m.isTargeted).toBe(false);
  });

  it('群聊 @bot 触发且剥离 mention 占位符（AC4.2）', () => {
    const m = normalizeFeishuMessage(
      base({
        message: {
          message_id: 'om_3',
          chat_id: 'oc_g1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 讲个笑话' }),
          mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Moss' }],
        },
      }),
      BOT_OPEN_ID,
    );
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('讲个笑话');
  });

  it('其他用户的 mention 还原为 @名字', () => {
    const m = normalizeFeishuMessage(
      base({
        message: {
          message_id: 'om_4',
          chat_id: 'oc_g1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 帮我@_user_2 一个忙' }),
          mentions: [
            { key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Moss' },
            { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
          ],
        },
      }),
      BOT_OPEN_ID,
    );
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('帮我@Alice 一个忙');
  });

  it('图片消息归一化为 image attachment（text 为空）', () => {
    const m = normalizeFeishuMessage(
      base({ message: { ...base().message, message_type: 'image', content: '{}' } }),
      BOT_OPEN_ID,
    );
    expect(m.text).toBe('');
    expect(m.attachments).toEqual([{ type: 'image' }]);
  });

  it('content 非 JSON 时不崩溃（text 为空）', () => {
    const m = normalizeFeishuMessage(
      base({ message: { ...base().message, content: '{broken' } }),
      BOT_OPEN_ID,
    );
    expect(m.text).toBe('');
  });
});

describe('buildStreamingCard', () => {
  it('生成 JSON 2.0 卡片且含 markdown 元素', () => {
    const card = JSON.parse(buildStreamingCard('Hello')) as {
      schema: string;
      body: { elements: { tag: string; content: string }[] };
    };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements[0]?.tag).toBe('markdown');
    expect(card.body.elements[0]?.content).toBe('Hello');
  });

  it('空文本用占位符', () => {
    const card = JSON.parse(buildStreamingCard('')) as {
      body: { elements: { content: string }[] };
    };
    expect(card.body.elements[0]?.content).toBe('…');
  });
});
