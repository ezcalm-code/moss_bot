import type { Attachment, PlatformId } from '../types';

export interface TelegramFromInfo {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessageLike {
  chat: { id: number | string; type: string };
  from?: TelegramFromInfo;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  reply_to_message?: { from?: TelegramFromInfo };
  photo?: unknown[];
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: { file_id?: string; mime_type?: string };
  sticker?: unknown;
}

/** 从消息（含被回复消息）中选出图片的 file_id：photo 取最大尺寸，图片文档次之 */
export function pickImageFileId(msg: TelegramMessageLike | undefined): string | undefined {
  if (!msg) return undefined;
  const photoSizes = msg.photo as { file_id: string }[] | undefined;
  if (Array.isArray(photoSizes) && photoSizes.length > 0) {
    return photoSizes[photoSizes.length - 1]?.file_id;
  }
  const doc = msg.document as { file_id?: string; mime_type?: string } | undefined;
  if (doc?.file_id && doc.mime_type?.startsWith('image/')) {
    return doc.file_id;
  }
  return undefined;
}

export interface NormalizedTelegramMessage {
  platform: PlatformId;
  chatId: string;
  senderId: string;
  senderName: string;
  isGroup: boolean;
  isTargeted: boolean;
  text: string;
  attachments: Attachment[];
}

function senderNameOf(from: TelegramFromInfo | undefined): string {
  if (!from) return 'Unknown';
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || from.username || String(from.id);
}

function attachmentsOf(msg: TelegramMessageLike): Attachment[] {
  const out: Attachment[] = [];
  if (msg.photo) out.push({ type: 'image' });
  if (msg.voice || msg.audio) out.push({ type: 'audio' });
  if (msg.video) out.push({ type: 'file' });
  if (msg.document) out.push({ type: 'file' });
  if (msg.sticker) out.push({ type: 'other' });
  return out;
}

/**
 * 把 Telegram update 中的 message 归一化为平台无关的消息体。
 * 群聊仅在 @bot 或回复 bot 消息时 targeted，且剥离 @botname 前缀；
 * 私聊恒 targeted。
 */
export function normalizeTelegramMessage(
  msg: TelegramMessageLike,
  bot: { id: number; username: string },
): NormalizedTelegramMessage {
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const rawText = msg.text ?? msg.caption ?? '';

  let isTargeted = !isGroup;
  let text = rawText;

  if (isGroup) {
    const mention = (msg.entities ?? []).some((e) => {
      if (e.type !== 'mention') return false;
      return (
        rawText.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${bot.username.toLowerCase()}`
      );
    });
    const replyToBot = msg.reply_to_message?.from?.id === bot.id;
    // 群聊命令（bot_command entity）：/cmd@本bot 视为对本 bot；
    // /cmd@其他bot 让给对方；裸 /cmd 按 Telegram 群组惯例视为对本 bot。
    let commandVerdict = false;
    for (const e of msg.entities ?? []) {
      if (e.type !== 'bot_command') continue;
      const cmd = rawText.slice(e.offset, e.offset + e.length).toLowerCase();
      commandVerdict = cmd.includes('@') ? cmd.includes(`@${bot.username.toLowerCase()}`) : true;
      break;
    }
    isTargeted = mention || replyToBot || commandVerdict;
    if (isTargeted) {
      text = rawText.replace(new RegExp(`@${bot.username}`, 'gi'), '');
    }
  }
  text = text.trim();

  return {
    platform: 'telegram',
    chatId: String(msg.chat.id),
    senderId: String(msg.from?.id ?? ''),
    senderName: senderNameOf(msg.from),
    isGroup,
    isTargeted,
    text,
    attachments: attachmentsOf(msg),
  };
}
