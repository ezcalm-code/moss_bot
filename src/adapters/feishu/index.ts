import * as Lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../log';
import type { IncomingMessage, PlatformAdapter, PlatformId } from '../types';
import { normalizeFeishuMessage } from './normalize';
import { FeishuSimpleReply, FeishuStreamReply, type FeishuCardApi } from './stream';

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  streaming: boolean;
  log: Logger;
}

const DOMAIN_HOST: Record<'feishu' | 'lark', string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

/** 手写 REST 获取 bot open_id：SDK 未封装 bot/v3/info */
async function fetchBotOpenId(appId: string, appSecret: string, host: string): Promise<string> {
  const tokenRes = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenData = (await tokenRes.json()) as { tenant_access_token?: string; msg?: string };
  const token = tokenData.tenant_access_token;
  if (!token) {
    throw new Error(`获取 tenant_access_token 失败: ${tokenData.msg ?? '未知错误'}`);
  }
  const infoRes = await fetch(`${host}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const infoData = (await infoRes.json()) as { data?: { open_id?: string } };
  const openId = infoData.data?.open_id;
  if (!openId) {
    throw new Error('获取机器人信息失败：bot/v3/info 未返回 open_id');
  }
  return openId;
}

export class FeishuAdapter implements PlatformAdapter {
  readonly id: PlatformId = 'feishu';
  private readonly client: Lark.Client;
  private ws: Lark.WSClient | undefined;
  private dispatch?: (msg: IncomingMessage) => Promise<void>;
  private botOpenId = '';

  constructor(private readonly opts: FeishuAdapterOptions) {
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    });
  }

  setDispatcher(dispatch: (msg: IncomingMessage) => Promise<void>): void {
    this.dispatch = dispatch;
  }

  async start(): Promise<void> {
    const host = DOMAIN_HOST[this.opts.domain];
    this.botOpenId = await fetchBotOpenId(this.opts.appId, this.opts.appSecret, host);
    this.opts.log.info({ botOpenId: this.botOpenId }, 'feishu 机器人信息获取成功');

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.onEvent(data);
      },
    });

    this.ws = new Lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      onReady: () => this.opts.log.info('feishu 长连接已建立'),
      onReconnecting: () => this.opts.log.warn('feishu 连接断开，重连中'),
      onReconnected: () => this.opts.log.info('feishu 重连成功'),
      onError: (err) => this.opts.log.error({ err }, 'feishu 连接失败'),
    });
    // start 在握手成功后返回，连接生命周期由 SDK 内部重连循环维持
    void this.ws.start({ eventDispatcher }).catch((err: unknown) => {
      this.opts.log.error({ err }, 'feishu 长连接启动失败');
    });
  }

  async stop(): Promise<void> {
    await this.ws?.close();
  }

  private async onEvent(data: unknown) {
    if (!data) return;
    const normalized = normalizeFeishuMessage(
      data as Parameters<typeof normalizeFeishuMessage>[0],
      this.botOpenId,
    );
    if (!normalized.isTargeted) return;

    const chatId = normalized.chatId;
    const cardApi = this.makeCardApi();
    const messageId = (data as { message?: { message_id?: string } }).message?.message_id;
    const imageKeys = this.collectImageKeys(data);
    const msg: IncomingMessage = {
      ...normalized,
      raw: data,
      reply: async (text) => {
        await cardApi.sendTextMessage(chatId, text);
      },
      startStreamReply: async () =>
        this.opts.streaming
          ? new FeishuStreamReply(cardApi, chatId, this.opts.log)
          : new FeishuSimpleReply(cardApi, chatId, this.opts.log),
      getAttachmentDataUrls: async () => {
        if (!messageId || imageKeys.length === 0) return [];
        const urls: string[] = [];
        for (const imageKey of imageKeys) {
          const buf = await this.downloadImageResource(messageId, imageKey);
          urls.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        }
        return urls;
      },
    };
    await this.dispatch?.(msg);
  }

  /** 收集图片消息的 image_key（content JSON 里的 image 字段） */
  private collectImageKeys(data: unknown): string[] {
    const message = (data as { message?: { message_type?: string; content?: string } }).message;
    if (message?.message_type !== 'image') return [];
    try {
      const key = JSON.parse(message.content ?? '{}')?.image;
      return typeof key === 'string' ? [key] : [];
    } catch {
      return [];
    }
  }

  /** 通过 SDK 下载飞书图片资源为 Buffer */
  private async downloadImageResource(messageId: string, imageKey: string): Promise<Buffer> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
    // SDK 返回 NodeJS.ReadableStream：收集为 Buffer
    const chunks: Buffer[] = [];
    const stream = res as unknown as NodeJS.ReadableStream;
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }

  private makeCardApi(): FeishuCardApi {
    const sendMessage = async (chatId: string, msgType: string, content: string) => {
      const res = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      });
      if (res.code !== 0) {
        throw new Error(`feishu 发送消息失败: ${res.code} ${res.msg}`);
      }
    };
    return {
      createCard: async (cardJson) => {
        const res = await this.client.cardkit.v1.card.create({
          data: { type: 'card_json', data: cardJson },
        });
        if (res.code !== 0 || !res.data?.card_id) {
          throw new Error(`feishu 创建卡片失败: ${res.code} ${res.msg}`);
        }
        return res.data.card_id;
      },
      sendCardMessage: async (chatId, cardId) => {
        await sendMessage(
          chatId,
          'interactive',
          JSON.stringify({ type: 'card', data: { card_id: cardId } }),
        );
      },
      updateCard: async (cardId, sequence, cardJson) => {
        const res = await this.client.cardkit.v1.card.update({
          data: { card: { type: 'card_json', data: cardJson }, sequence },
          path: { card_id: cardId },
        });
        if (res.code !== 0) {
          throw new Error(`feishu 更新卡片失败: ${res.code} ${res.msg}`);
        }
      },
      sendTextMessage: async (chatId, text) => {
        await sendMessage(chatId, 'text', JSON.stringify({ text }));
      },
    };
  }
}
