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
  post: 'other',
  share_chat: 'other',
  share_user: 'other',
  sticker: 'other',
};

/**
 * 飞书 im.message.receive_v1 事件归一化：
 * - 仅 p2p 恒 targeted；群聊需 @bot（mentions 中含 bot open_id）
 * - bot 自己的 mention 占位符剥离，其他用户的 mention 还原为 @名字
 * - content 是 JSON 字符串（text 类型为 {"text":"..."}）
 */
export function normalizeFeishuMessage(
  event: FeishuEventLike,
  botOpenId: string,
): NormalizedFeishuMessage {
  const { message, sender } = event;
  const isGroup = message.chat_type === 'group';

  let text = '';
  if (message.message_type === 'text') {
    try {
      text = String(JSON.parse(message.content)?.text ?? '');
    } catch {
      text = '';
    }
  }

  const attachments: Attachment[] = [];
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
