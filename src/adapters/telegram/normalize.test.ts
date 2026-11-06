import { describe, expect, it } from 'vitest';
import { normalizeTelegramMessage, type TelegramMessageLike } from './normalize';

const bot = { id: 42, username: 'moss_bot' };

function base(overrides: Partial<TelegramMessageLike> = {}): TelegramMessageLike {
  return {
    chat: { id: 100, type: 'private' },
    from: { id: 7, first_name: 'Alice' },
    text: '你好',
    ...overrides,
  };
}

describe('normalizeTelegramMessage', () => {
  it('私聊恒 targeted，内容不剥离', () => {
    const m = normalizeTelegramMessage(base(), bot);
    expect(m.isGroup).toBe(false);
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('你好');
    expect(m.chatId).toBe('100');
    expect(m.senderId).toBe('7');
    expect(m.senderName).toBe('Alice');
  });

  it('群聊无 mention / 无回复时不 targeted（AC3.2 前置）', () => {
    const m = normalizeTelegramMessage(
      base({ chat: { id: 1, type: 'group' }, text: '大家聊聊' }),
      bot,
    );
    expect(m.isGroup).toBe(true);
    expect(m.isTargeted).toBe(false);
  });

  it('群聊 @bot 触发且剥离 @botname（AC3.2）', () => {
    const m = normalizeTelegramMessage(
      base({
        chat: { id: 1, type: 'supergroup' },
        text: '@moss_bot 讲个笑话',
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      }),
      bot,
    );
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('讲个笑话');
  });

  it('群聊中消息中间位置的 mention 也触发', () => {
    const text = 'hey @moss_bot 帮个忙';
    const m = normalizeTelegramMessage(
      base({
        chat: { id: 1, type: 'group' },
        text,
        entities: [{ type: 'mention', offset: 4, length: 9 }],
      }),
      bot,
    );
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('hey  帮个忙');
  });

  it('回复 bot 消息触发', () => {
    const m = normalizeTelegramMessage(
      base({
        chat: { id: 1, type: 'group' },
        text: '再详细说说',
        reply_to_message: { from: { id: 42, first_name: 'Moss' } },
      }),
      bot,
    );
    expect(m.isTargeted).toBe(true);
    expect(m.text).toBe('再详细说说');
  });

  it('回复他人消息不触发', () => {
    const m = normalizeTelegramMessage(
      base({
        chat: { id: 1, type: 'group' },
        text: '你说得对',
        reply_to_message: { from: { id: 99, first_name: 'Bob' } },
      }),
      bot,
    );
    expect(m.isTargeted).toBe(false);
  });

  it('带图片的消息归一化出 image attachment', () => {
    const m = normalizeTelegramMessage(base({ photo: [{}] }), bot);
    expect(m.attachments).toEqual([{ type: 'image' }]);
  });

  it('from 缺失时降级不崩溃', () => {
    const m = normalizeTelegramMessage(base({ from: undefined }), bot);
    expect(m.senderId).toBe('');
    expect(m.senderName).toBe('Unknown');
  });
});
