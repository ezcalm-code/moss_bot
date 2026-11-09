import type { Attachment, PlatformId } from '../types';

export interface FeishuMention {
  key: string;
  id: { open_id?: string };
  name: string;
}

export interface FeishuEventLike {
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
  };
  sender: { sender_id?: { open_id?: string } };
}

export interface NormalizedFeishuMessage {
  platform: PlatformId;
  chatId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  isTargeted: boolean;
  text: string;
  attachments: Attachment[];
}

const MESSAGE_TYPE_TO_ATTACHMENT: Record<string, Attachment['type']> = {
  image: 'image',
  audio: 'audio',
  media: 'file',
  file: 'file',
  share_chat: 'other',
  share_user: 'other',
  sticker: 'other',
};

/**
 * 飞书 im.message.receive_v1 事件归一化：
 * - 仅 p2p 恒 targeted；群聊需 @bot（mentions 中含 bot open_id）
 * - bot 自己的 mention 占位符剥离，其他用户的 mention 还原为 @名字
 * - content 是 JSON 字符串（text 类型为 {"text":"..."}）
 * - post（富文本，图文混排）提取 text 段与 img 段
 */
export function normalizeFeishuMessage(
  event: FeishuEventLike,
  botOpenId: string,
): NormalizedFeishuMessage {
  const { message, sender } = event;
  const isGroup = message.chat_type === 'group';

  let text = '';
  let imageKeys: string[] = [];
  if (message.message_type === 'text') {
    try {
      text = String(JSON.parse(message.content)?.text ?? '');
    } catch {
      text = '';
    }
  } else if (message.message_type === 'post') {
    const post = extractPostContent(message.content);
    text = post.text;
    imageKeys = post.imageKeys;
  }

  const attachments: Attachment[] = imageKeys.map(() => ({ type: 'image' as const }));
  const attachmentType = MESSAGE_TYPE_TO_ATTACHMENT[message.message_type];
  if (attachmentType) attachments.push({ type: attachmentType });

  let isTargeted = !isGroup;
  if (isGroup) {
    const botMention = (message.mentions ?? []).find((m) => m.id.open_id === botOpenId);
    isTargeted = Boolean(botMention);
    if (botMention) {
      text = text.split(botMention.key).join('');
      for (const m of message.mentions ?? []) {
        if (m !== botMention) {
          text = text.split(m.key).join(`@${m.name}`);
        }
      }
    }
  }

  return {
    platform: 'feishu',
    chatId: message.chat_id,
    senderId: sender.sender_id?.open_id ?? '',
    senderName: sender.sender_id?.open_id ?? 'Unknown',
    isGroup,
    isTargeted,
    text: text.trim(),
    attachments,
  };
}

interface PostParts {
  text: string;
  imageKeys: string[];
}

/** 递归收集富文本内容里的 text 与 img 段（兼容旧版二维段落结构与 v2 平铺结构） */
function collectPostParts(node: unknown, parts: PostParts): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPostParts(item, parts);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as {
      tag?: string;
      text?: string;
      image_key?: string;
      user_name?: string;
      content?: unknown;
    };
    if (obj.tag === 'text' && typeof obj.text === 'string') {
      parts.text = `${parts.text}${obj.text}`;
    } else if (obj.tag === 'img' && typeof obj.image_key === 'string') {
      parts.imageKeys.push(obj.image_key);
    } else if (obj.tag === 'at') {
      // at 段的名字在 text 或 user_name 字段
      const name = typeof obj.text === 'string' ? obj.text : obj.user_name;
      if (typeof name === 'string') parts.text = `${parts.text}@${name}`;
    }
    if (obj.content !== undefined) collectPostParts(obj.content, parts);
  }
}

/** 解析 post 富文本消息的 content：返回纯文本与图片 key 列表 */
export function extractPostContent(content: string): PostParts {
  const parts: PostParts = { text: '', imageKeys: [] };
  try {
    const parsed = JSON.parse(content) as unknown;
    // 旧版结构含 title 字段
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { content?: unknown }).content)
    ) {
      collectPostParts((parsed as { content: unknown }).content, parts);
    } else {
      collectPostParts(parsed, parts);
    }
  } catch {
    // 解析失败按空处理
  }
  return parts;
}

/** 卡片 JSON 2.0 结构：单一 markdown 元素承载流式文本 */
export function buildStreamingCard(markdown: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: markdown || '…',
        },
      ],
    },
  });
}
