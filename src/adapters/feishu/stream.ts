import type { StreamReplyHandle } from '../types';
import { buildStreamingCard } from './normalize';

export interface FeishuCardApi {
  /** 创建卡片实体，返回 card_id */
  createCard(cardJson: string): Promise<string>;
  /** 发送引用卡片实体的消息 */
  sendCardMessage(chatId: string, cardId: string): Promise<void>;
  /** 全量更新卡片实体内容（sequence 必须严格递增） */
  updateCard(cardId: string, sequence: number, cardJson: string): Promise<void>;
  sendTextMessage(chatId: string, text: string): Promise<void>;
}

export interface FeishuStreamOptions {
  /** 流式更新最小间隔 */
  minIntervalMs?: number;
  /** 注入时钟，测试用 */
  now?: () => number;
}

const CARD_UPDATE_INTERVAL_MS = 800;

/**
 * 飞书流式回复：创建卡片实体 → 发送引用消息 → 节流全量更新卡片内容。
 * 任一卡片 API 失败即降级为一次性文本消息（全文兜底），不向用户暴露半截卡片。
 */
export class FeishuStreamReply implements StreamReplyHandle {
  private readonly minIntervalMs: number;
  private readonly now: () => number;

  private buffer = '';
  private cardId: string | undefined;
  private cardFailed = false;
  private lastUpdateAt = 0;
  /** 飞书卡片约束：sequence 必须从 1 起严格递增，传 0 报 300317 且后续更新全部失败 */
  private sequence = 1;
  private finishedOrAborted = false;

  constructor(
    private readonly api: FeishuCardApi,
    private readonly chatId: string,
    private readonly log: { warn: (obj: unknown, msg: string) => void },
    opts: FeishuStreamOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? CARD_UPDATE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
  }

  async append(delta: string): Promise<void> {
    this.buffer += delta;
    if (this.cardFailed) return;
    if (this.cardId === undefined) {
      await this.startCard();
      return;
    }
    if (this.now() - this.lastUpdateAt >= this.minIntervalMs) {
      await this.updateCardSafe();
    }
  }

  async finish(): Promise<void> {
    if (this.finishedOrAborted) return;
    this.finishedOrAborted = true;
    if (this.cardFailed || this.cardId === undefined) {
      await this.sendTextSafe(this.buffer || '（空回复）');
      return;
    }
    // 定稿失败不允许静默丢失回复，必须以文本兜底
    try {
      if (this.cardId !== undefined) {
        await this.updateCard(this.cardId, this.buffer);
      }
    } catch (err) {
      this.log.warn({ err }, 'feishu 卡片定稿失败，降级为文本消息');
      await this.sendTextSafe(this.buffer);
    }
  }

  async abort(err: Error): Promise<void> {
    if (this.finishedOrAborted) return;
    this.finishedOrAborted = true;
    const text = `生成中断：${err.message}`;
    if (this.cardId !== undefined && !this.cardFailed) {
      try {
        await this.updateCard(this.cardId, text);
        return;
      } catch (updateErr) {
        this.log.warn({ err: updateErr }, 'feishu abort 卡片更新失败，降级为文本');
      }
    }
    await this.sendTextSafe(text);
  }

  private async startCard(): Promise<void> {
    try {
      const cardJson = buildStreamingCard(this.buffer);
      this.cardId = await this.api.createCard(cardJson);
      await this.api.sendCardMessage(this.chatId, this.cardId);
      this.lastUpdateAt = this.now();
    } catch (err) {
      // 不立即发文本：由 finish / abort 统一兜底，避免重复消息
      this.cardFailed = true;
      this.log.warn({ err }, 'feishu 流式卡片创建失败，降级为文本消息');
    }
  }

  private async updateCardSafe(): Promise<void> {
    if (this.cardId === undefined) return;
    try {
      await this.updateCard(this.cardId, this.buffer);
      this.lastUpdateAt = this.now();
    } catch (err) {
      // 下个节流周期会带全量内容重试；finish 时仍有文本兜底
      this.log.warn({ err }, 'feishu 卡片更新失败');
    }
  }

  private async updateCard(cardId: string, markdown: string): Promise<void> {
    await this.api.updateCard(cardId, this.sequence++, buildStreamingCard(markdown));
  }

  private async sendTextSafe(text: string): Promise<void> {
    try {
      await this.api.sendTextMessage(this.chatId, text);
    } catch (err) {
      this.log.warn({ err }, 'feishu 文本消息发送失败');
    }
  }
}

/** streaming=false 时的非流式实现：append 累积、finish 一次性发送 */
export class FeishuSimpleReply implements StreamReplyHandle {
  private buffer = '';

  constructor(
    private readonly api: FeishuCardApi,
    private readonly chatId: string,
    private readonly log: { warn: (obj: unknown, msg: string) => void },
  ) {}

  async append(delta: string): Promise<void> {
    this.buffer += delta;
  }

  async finish(): Promise<void> {
    try {
      await this.api.sendTextMessage(this.chatId, this.buffer);
    } catch (err) {
      this.log.warn({ err }, 'feishu 文本消息发送失败');
    }
  }

  async abort(err: Error): Promise<void> {
    try {
      await this.api.sendTextMessage(this.chatId, `生成中断：${err.message}`);
    } catch (sendErr) {
      this.log.warn({ err: sendErr }, 'feishu 文本消息发送失败');
    }
  }
}
