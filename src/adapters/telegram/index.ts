import { Bot } from 'grammy';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { Logger } from '../../log';
import type { IncomingMessage, PlatformAdapter, PlatformId } from '../types';
import { normalizeTelegramMessage } from './normalize';
import { TelegramStreamReply } from './stream';
import type { Dispatcher } from 'undici';

export interface TelegramAdapterOptions {
  botToken: string;
  log: Logger;
  /** 代理出站（HTTP(S)_PROXY 环境变量）；api.telegram.org 需代理的环境必传 */
  proxyDispatcher?: Dispatcher;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly id: PlatformId = 'telegram';
  private readonly grammy: Bot;
  private dispatch?: (msg: IncomingMessage) => Promise<void>;

  constructor(private readonly opts: TelegramAdapterOptions) {
    // grammY 在 Node 下默认走自带的 node-fetch v2（不认 undici 的 dispatcher），
    // 显式传全局 fetch + dispatcher 让 API 请求经 HTTP(S)_PROXY 出站
    const client = {
      fetch: globalThis.fetch,
      ...(opts.proxyDispatcher && {
        baseFetchConfig: {
          dispatcher: opts.proxyDispatcher,
        } as unknown as Omit<
          NonNullable<Parameters<typeof fetch>[1]>,
          'method' | 'headers' | 'body'
        >,
      }),
    };
    this.grammy = new Bot(opts.botToken, { client });
    // 429 限流退避由官方 throttler 承担
    this.grammy.api.config.use(apiThrottler());
  }

  setDispatcher(dispatch: (msg: IncomingMessage) => Promise<void>): void {
    this.dispatch = dispatch;
  }

  async start(): Promise<void> {
    this.grammy.catch((err) => {
      this.opts.log.error({ err: err.error }, 'telegram 更新处理失败');
    });

    this.grammy.on('message', async (ctx) => {
      const raw = ctx.message;
      if (!raw || !ctx.me) return;
      const normalized = normalizeTelegramMessage(raw, {
        id: ctx.me.id,
        username: ctx.me.username,
      });
      if (!normalized.isTargeted) return;

      const chatId = normalized.chatId;
      const msg: IncomingMessage = {
        ...normalized,
        raw,
        reply: async (text) => {
          await ctx.api.sendMessage(chatId, text);
        },
        startStreamReply: async () => new TelegramStreamReply(ctx.api, chatId, this.opts.log),
        getAttachmentDataUrls: async () => {
          // photo 数组按尺寸升序排列，取最后一个（最大）；文档类图片也支持
          let fileId: string | undefined;
          const photoSizes = raw.photo as { file_id: string }[] | undefined;
          if (Array.isArray(photoSizes) && photoSizes.length > 0) {
            fileId = photoSizes[photoSizes.length - 1]?.file_id;
          } else if (
            raw.document &&
            (raw.document as { mime_type?: string }).mime_type?.startsWith('image/')
          ) {
            fileId = (raw.document as { file_id: string }).file_id;
          }
          if (!fileId) return [];
          const file = await ctx.api.getFile(fileId);
          const url = `https://api.telegram.org/file/bot${this.opts.botToken}/${file.file_path}`;
          const res = await fetch(url, {
            dispatcher: this.opts.proxyDispatcher,
          } as RequestInit);
          if (!res.ok) {
            throw new Error(`telegram 图片下载失败: HTTP ${res.status}`);
          }
          const buf = Buffer.from(await res.arrayBuffer());
          return [`data:image/jpeg;base64,${buf.toString('base64')}`];
        },
      };
      await this.dispatch?.(msg);
    });

    // 丢弃长轮询启动前积压的更新，避免重启后回复历史消息；
    // 网络抖动时降级继续（后果只是可能处理少量积压消息）
    try {
      await this.grammy.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      this.opts.log.warn({ err }, 'telegram deleteWebhook 失败，跳过积压清理继续启动');
    }
    void this.grammy.start({
      onStart: (me) => {
        this.opts.log.info({ username: me.username }, 'telegram bot 已启动（长轮询）');
      },
    });
  }

  async stop(): Promise<void> {
    await this.grammy.stop();
  }

  async registerCommands(
    commands: readonly { name: string; description: string }[],
  ): Promise<void> {
    await this.grammy.api.setMyCommands(
      commands.map((c) => ({ command: c.name, description: c.description })),
    );
  }
}
