import type { StreamReplyHandle } from '../types';

export const TELEGRAM_MESSAGE_MAX_LEN = 4000;

export interface TelegramSendOpts {
  /** legacy 方言：转义要求少；解析失败时由调用方降级纯文本重发 */
  parse_mode?: 'Markdown';
}

export interface TelegramStreamApi {
  sendMessage(chatId: string, text: string, opts?: TelegramSendOpts): Promise<{ message_id: number }>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: TelegramSendOpts,
  ): Promise<unknown>;
}

export interface TelegramStreamOptions {
  /** 首条消息发出前的占位文案 */
  placeholder?: string;
  minIntervalMs?: number;
  minChars?: number;
  maxLen?: number;
  /** 注入时钟，测试用 */
  now?: () => number;
}

export class StreamThrottle {
  private lastEditAt: number | undefined;
  private sinceEdit = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly minChars: number,
    private readonly now: () => number,
  ) {}

  /** 记录一次真实编辑（发送首条消息也算），作为节流基准 */
  mark(): void {
    this.lastEditAt = this.now();
    this.sinceEdit = 0;
  }

  shouldEdit(addedChars: number): boolean {
    this.sinceEdit += addedChars;
    if (
      this.lastEditAt === undefined ||
      this.now() - this.lastEditAt >= this.minIntervalMs ||
      this.sinceEdit >= this.minChars
    ) {
      this.mark();
      return true;
    }
    return false;
  }
}

export function isNotModifiedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('message is not modified');
}

/** 按 maxLen 切分长文本（不含空段） */
export function splitChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

/**
 * Telegram 流式回复状态机：
 * - buffer[0..sealedLen) 已通过 sendMessage 定稿
 * - 最后一条消息（lastMessageId）应显示 buffer.slice(sealedLen)
 * - append 节流（≥1.2s 或 ≥64 字符）触发渲染；渲染时超长部分定稿续发新消息
 */
export class TelegramStreamReply implements StreamReplyHandle {
  private readonly throttle: StreamThrottle;
  private readonly maxLen: number;
  private readonly placeholder: string;

  private buffer = '';
  private sealedLen = 0;
  private lastMessageId: number | undefined;
  /** LLM 输出含未闭合 * / _ 等 Telegram 会拒收整条；置位后本条回复余下全部纯文本 */
  private markdownBroken = false;

  constructor(
    private readonly api: TelegramStreamApi,
    private readonly chatId: string,
    private readonly log: { warn: (obj: unknown, msg: string) => void },
    opts: TelegramStreamOptions = {},
  ) {
    this.placeholder = opts.placeholder ?? '…';
    this.maxLen = opts.maxLen ?? TELEGRAM_MESSAGE_MAX_LEN;
    this.throttle = new StreamThrottle(
      opts.minIntervalMs ?? 1200,
      opts.minChars ?? 64,
      opts.now ?? Date.now,
    );
  }

  async append(delta: string): Promise<void> {
    this.buffer += delta;
    if (this.lastMessageId === undefined) {
      // 首个 delta 到达即发首条，让用户立刻看到输出开始
      await this.render();
      return;
    }
    if (this.throttle.shouldEdit(delta.length)) {
      await this.render();
    }
  }

  async finish(): Promise<void> {
    if (this.lastMessageId === undefined) {
      await this.render();
      return;
    }
    // 无条件终渲染：内容未变时 Telegram 的 "message is not modified" 被 editSafe 吞掉
    await this.render();
  }

  async abort(err: Error): Promise<void> {
    const text = `生成中断：${err.message}`;
    try {
      if (this.lastMessageId === undefined) {
        await this.sendMessageSafe(text);
      } else {
        await this.editSafe(text);
      }
    } catch (editErr) {
      this.log.warn({ err: editErr }, 'telegram abort 编辑失败');
    }
  }

  private async render(): Promise<void> {
    try {
      // 超出单条上限的完整段逐条定稿
      while (this.buffer.length - this.sealedLen > this.maxLen) {
        const chunk = this.buffer.slice(this.sealedLen, this.sealedLen + this.maxLen);
        const sent = await this.sendMessageSafe(chunk);
        this.sealedLen += this.maxLen;
        this.lastMessageId = sent.message_id;
      }
      const rest = this.buffer.slice(this.sealedLen);
      if (this.lastMessageId === undefined) {
        const sent = await this.sendMessageSafe(rest || this.placeholder);
        this.lastMessageId = sent.message_id;
        this.throttle.mark();
      } else {
        await this.editSafe(rest || this.placeholder);
        this.throttle.mark();
      }
    } catch (err) {
      // 单次渲染失败不终止流：下一个 delta / finish 会再次尝试
      if (!isNotModifiedError(err)) {
        this.log.warn({ err }, 'telegram 流式渲染失败');
      }
    }
  }

  /** markdown 优先；被 Telegram 拒收（语法解析失败）则降级纯文本并记住，后续不再尝试 */
  private async sendMessageSafe(text: string): Promise<{ message_id: number }> {
    if (!this.markdownBroken) {
      try {
        return await this.api.sendMessage(this.chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        this.markdownBroken = true;
        this.log.warn({ err }, 'telegram markdown 发送被拒，本条回复降级为纯文本');
      }
    }
    return this.api.sendMessage(this.chatId, text);
  }

  private async editSafe(text: string): Promise<void> {
    if (this.lastMessageId === undefined) return;
    if (!this.markdownBroken) {
      try {
        await this.api.editMessageText(this.chatId, this.lastMessageId, text, {
          parse_mode: 'Markdown',
        });
        return;
      } catch (err) {
        if (isNotModifiedError(err)) return;
        this.markdownBroken = true;
        this.log.warn({ err }, 'telegram markdown 编辑被拒，本条回复降级为纯文本');
      }
    }
    await this.api.editMessageText(this.chatId, this.lastMessageId, text);
  }
}
