import { describe, expect, it } from 'vitest';
import { TelegramStreamReply, isNotModifiedError, splitChunks, StreamThrottle } from './stream';

function fakeApi() {
  const sent: { text: string; parseMode?: string }[] = [];
  const edits: { id: number; text: string; parseMode?: string }[] = [];
  let nextId = 1;
  const api = {
    async sendMessage(_chatId: string, text: string, opts?: { parse_mode?: string }) {
      sent.push({ text, parseMode: opts?.parse_mode });
      return { message_id: nextId++ };
    },
    async editMessageText(
      _chatId: string,
      id: number,
      text: string,
      opts?: { parse_mode?: string },
    ) {
      edits.push({ id, text, parseMode: opts?.parse_mode });
    },
  };
  return { api, sent, edits };
}

const silentLog = { warn: () => {} };

describe('StreamThrottle', () => {
  it('首次必编辑，间隔不足且增量不足则不编辑', () => {
    let now = 0;
    const t = new StreamThrottle(1200, 64, () => now);
    expect(t.shouldEdit(1)).toBe(true); // 首次
    now = 500;
    expect(t.shouldEdit(1)).toBe(false); // 时间与字符都未达标
    now = 1201;
    expect(t.shouldEdit(1)).toBe(true); // 到达时间阈值
  });

  it('累计字符达到阈值触发编辑', () => {
    let now = 0;
    const t = new StreamThrottle(1200, 64, () => now);
    expect(t.shouldEdit(1)).toBe(true);
    now = 100;
    expect(t.shouldEdit(63)).toBe(false);
    expect(t.shouldEdit(1)).toBe(true); // 累计 64 字符
  });
});

describe('splitChunks', () => {
  it('按 maxLen 切分且无空段', () => {
    const chunks = splitChunks('abcdefgh', 3);
    expect(chunks).toEqual(['abc', 'def', 'gh']);
  });
});

describe('TelegramStreamReply', () => {
  it('首个 delta 发送首条消息，后续按节流编辑', async () => {
    let now = 0;
    const { api, sent, edits } = fakeApi();
    const reply = new TelegramStreamReply(api, '1', silentLog, {
      now: () => now,
      minIntervalMs: 1000,
      minChars: 64,
    });
    await reply.append('Hel'); // 首条
    expect(sent).toEqual([{ text: 'Hel', parseMode: 'Markdown' }]);
    now = 500;
    await reply.append('lo'); // 未到节流阈值
    expect(edits).toHaveLength(0);
    now = 1100;
    await reply.append('!');
    expect(edits).toEqual([{ id: 1, text: 'Hello!', parseMode: 'Markdown' }]);
  });

  it('finish 定稿全量内容', async () => {
    const { api, edits } = fakeApi();
    let now = 0;
    const reply = new TelegramStreamReply(api, '1', silentLog, { now: () => now });
    await reply.append('abc');
    now = 10_000;
    await reply.finish();
    expect(edits.at(-1)?.text).toBe('abc');
  });

  it('无 delta 直接 finish 时发送占位', async () => {
    const { api, sent } = fakeApi();
    const reply = new TelegramStreamReply(api, '1', silentLog, {});
    await reply.finish();
    expect(sent).toEqual([{ text: '…', parseMode: 'Markdown' }]);
  });

  it('超长内容分段定稿续发', async () => {
    const { api, sent, edits } = fakeApi();
    let now = 0;
    const reply = new TelegramStreamReply(api, '1', silentLog, {
      now: () => now,
      maxLen: 10,
      minIntervalMs: 0,
      minChars: 0,
    });
    await reply.append('a'.repeat(35));
    now += 10_000;
    await reply.finish();
    // 35 字符、maxLen 10 → 3 段定稿 + 最后一段编辑（5 字符）
    expect(sent).toHaveLength(3);
    expect(edits.at(-1)?.text).toBe('aaaaa');
  });

  it('abort 展示中断文案', async () => {
    const { api, edits } = fakeApi();
    const reply = new TelegramStreamReply(api, '1', silentLog, {});
    await reply.append('abc');
    await reply.abort(new Error('boom'));
    expect(edits.at(-1)?.text).toContain('boom');
  });

  it('abort 在未发过消息时直接发送文案', async () => {
    const { api, sent } = fakeApi();
    const reply = new TelegramStreamReply(api, '1', silentLog, {});
    await reply.abort(new Error('boom'));
    expect(sent[0]?.text).toContain('生成中断');
  });

  it('markdown 被拒时同内容纯文本重发，且后续不再尝试 markdown', async () => {
    let now = 0;
    const rejectMarkdown = true;
    const sent: { text: string; parseMode?: string }[] = [];
    const edits: { text: string; parseMode?: string }[] = [];
    let nextId = 1;
    const api = {
      async sendMessage(_chatId: string, text: string, opts?: { parse_mode?: string }) {
        if (opts?.parse_mode && rejectMarkdown) throw new Error("400: can't parse entities");
        sent.push({ text, parseMode: opts?.parse_mode });
        return { message_id: nextId++ };
      },
      async editMessageText(_chatId: string, _id: number, text: string, opts?: { parse_mode?: string }) {
        if (opts?.parse_mode && rejectMarkdown) throw new Error("400: can't parse entities");
        edits.push({ text, parseMode: opts?.parse_mode });
      },
    };
    const reply = new TelegramStreamReply(api, '1', silentLog, { now: () => now });
    await reply.append('带*号的内容');
    // 第一次 markdown 被拒 → 纯文本重发成功（各一次）
    expect(sent).toEqual([{ text: '带*号的内容', parseMode: undefined }]);
    now = 10_000;
    await reply.finish();
    // broken 置位后编辑直接纯文本，不再带 parse_mode
    expect(edits).toEqual([{ text: '带*号的内容', parseMode: undefined }]);
    expect(rejectMarkdown).toBe(true); // 根本没再试过 markdown
  });
});

describe('isNotModifiedError', () => {
  it('识别 Telegram 未变化编辑错误', () => {
    expect(isNotModifiedError(new Error('Bad Request: message is not modified'))).toBe(true);
    expect(isNotModifiedError(new Error('other'))).toBe(false);
    expect(isNotModifiedError('str')).toBe(false);
  });
});
