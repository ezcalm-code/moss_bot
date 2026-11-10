import * as Lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../../log';
import type { IncomingMessage, PlatformAdapter, PlatformId } from '../types';
import { extractPostContent, normalizeFeishuMessage } from './normalize';
import { buildPollCardJson, type PollsService } from '../../polls/service';
import { FeishuSimpleReply, FeishuStreamReply, type FeishuCardApi } from './stream';

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  streaming: boolean;
  log: Logger;
  /** 群投票：注入后卡片按钮回调才可用（开发者后台需开启卡片回调订阅） */
  polls?: PollsService;
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
  const infoData = (await infoRes.json()) as {
    bot?: { open_id?: string };
    data?: { open_id?: string; bot?: { open_id?: string } };
  };
  // 实测响应顶层即 bot.open_id（bot 能力开启前接口报 11205）
  const openId = infoData.data?.open_id ?? infoData.data?.bot?.open_id ?? infoData.bot?.open_id;
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
      // WS 模式下卡片回调（按钮点击）也经同一 dispatcher 按 event_type 路由（SDK 源码确认无独立 cardDispatcher 入参）
      ...(this.opts.polls && {
        'card.action.trigger': async (data: unknown) => this.onCardAction(data),
      }),
    });

    // 飞书在事件未及时确认时会重推（同一条消息回复两次的根因）：
    // onEvent 只做归一化与下载的快速部分，LLM 回复改为异步派发，让事件尽快确认。
    // BotCore.handle 内部已完整兜底错误，不会静默丢失。

    this.ws = new Lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      // 诊断期临时开启：观察 WS 订阅注册与事件帧
      loggerLevel: Lark.LoggerLevel.info,
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

  /** 主动推送（定时提醒）：文本消息不依赖收件事件，与 reply 同一条发送通道 */
  async sendTo(chatId: string, text: string): Promise<void> {
    await this.makeCardApi().sendTextMessage(chatId, text);
  }

  /** 生成图投递：下载直链字节 → 上传飞书素材 → 发图片消息 */
  async sendImage(chatId: string, image: { url: string }): Promise<void> {
    const res = await fetch(image.url);
    if (!res.ok) {
      throw new Error(`生成图下载失败: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const uploaded = await this.client.im.v1.image.create({
      data: { image_type: 'message', image: buf },
    });
    const imageKey = uploaded?.image_key;
    if (!imageKey) {
      throw new Error('飞书图片上传未返回 image_key');
    }
    await this.makeCardApi().sendMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }));
  }

  /** 发送投票卡片（按钮 value 携带 poll_id 与 option_idx，点击经 cardDispatcher 回来） */
  async sendPollCard(
    chatId: string,
    pollId: string,
    question: string,
    options: string[],
  ): Promise<void> {
    await this.makeCardApi().sendCardMessage(chatId, await this.makeCardApi().createCard(buildPollCardJson(question, options, pollId)));
  }

  /**
   * 卡片按钮回调：投票计票 + toast 反馈（内存操作，远小于 3 秒响应约束）。
   * 首次联调时全量打结构日志——回调实际形状以真机为准（教训⑫）。
   */
  private async onCardAction(data: unknown): Promise<Record<string, unknown>> {
    this.opts.log.info({ data }, 'feishu 卡片回调');
    const value = (data as { action?: { value?: Record<string, unknown> } })?.action?.value;
    if (!value || value.type !== 'poll_vote' || !this.opts.polls) return {};
    const voter =
      (data as { operator?: { open_id?: string } })?.operator?.open_id ??
      (data as { operator_id?: { open_id?: string } })?.operator_id?.open_id ??
      'unknown';
    const result = this.opts.polls.vote(String(value.poll_id), voter, Number(value.option_idx));
    return { toast: { type: result.ok ? 'info' : 'error', content: result.toast } };
  }

  private async onEvent(data: unknown) {
    if (!data) return;
    const rawMessage = (data as { message?: Record<string, unknown> }).message ?? {};
    this.opts.log.info(
      {
        messageType: rawMessage.message_type,
        chatType: rawMessage.chat_type,
        messageId: rawMessage.message_id,
        hasParent: Boolean(rawMessage.parent_id),
      },
      'feishu 收到消息事件',
    );
    const normalized = normalizeFeishuMessage(
      data as Parameters<typeof normalizeFeishuMessage>[0],
      this.botOpenId,
    );
    if (!normalized.isTargeted) {
      this.opts.log.info({ senderId: normalized.senderId }, '群聊消息未 @bot，忽略');
      return;
    }

    const chatId = normalized.chatId;
    const cardApi = this.makeCardApi();
    const messageId = (data as { message?: { message_id?: string } }).message?.message_id;
    const parentId = (data as { message?: { parent_id?: string } }).message?.parent_id;
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
        this.opts.log.info(
          {
            messageType: (data as { message?: { message_type?: string } }).message?.message_type,
            imageKeys: imageKeys.length,
            hasParent: Boolean(parentId),
          },
          'feishu 取图路径',
        );
        // 本条是图片消息：直接下载
        if (messageId && imageKeys.length > 0) {
          const urls: string[] = [];
          for (const imageKey of imageKeys) {
            const buf = await this.downloadImageResource(messageId, imageKey);
            urls.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
          }
          return urls;
        }
        // 回复了一条图片消息（图片在被回复消息里）：反查 parent 消息取 image_key
        if (messageId && parentId) {
          const parentKey = await this.fetchParentImageKey(parentId);
          this.opts.log.info({ parentKey: parentKey ?? null }, 'feishu 反查结果');
          if (parentKey) {
            const buf = await this.downloadImageResource(parentId, parentKey);
            return [`data:image/jpeg;base64,${buf.toString('base64')}`];
          }
        }
        return [];
      },
    };
    // 异步派发：handler 立即返回以确认事件；消息处理（LLM 回复）在后台完成
    void this.dispatch?.(msg).catch((err: unknown) => {
      this.opts.log.error({ err, chatId }, '消息异步处理失败');
    });
  }

  /** 回复场景：反查被回复消息，若含图片（image 或 post 富文本）则返回第一个 image_key */
  private async fetchParentImageKey(parentId: string): Promise<string | undefined> {
    const res = await this.client.im.v1.message.get({ path: { message_id: parentId } });
    const item = res.data?.items?.[0];
    if (item?.msg_type === 'image') {
      try {
        const key = JSON.parse(item.body?.content ?? '{}')?.image_key;
        return typeof key === 'string' ? key : undefined;
      } catch {
        return undefined;
      }
    }
    if (item?.msg_type === 'post') {
      return extractPostContent(item.body?.content ?? '').imageKeys[0];
    }
    return undefined;
  }

  /** 收集图片消息的 image_key（image 消息或 post 富文本内嵌图片） */
  private collectImageKeys(data: unknown): string[] {
    const message = (data as { message?: { message_type?: string; content?: string } }).message;
    if (!message) return [];
    if (message.message_type === 'image') {
      try {
        const key = JSON.parse(message.content ?? '{}')?.image_key;
        return typeof key === 'string' ? [key] : [];
      } catch {
        return [];
      }
    }
    if (message.message_type === 'post') {
      return extractPostContent(message.content ?? '').imageKeys;
    }
    return [];
  }

  /** 通过 SDK 下载飞书图片资源为 Buffer */
  private async downloadImageResource(messageId: string, imageKey: string): Promise<Buffer> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    });
    // SDK 返回包装对象：getReadableStream() 才是真正的流
    const readable = res.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
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
      sendMessage,
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
