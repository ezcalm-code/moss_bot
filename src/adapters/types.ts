export type PlatformId = 'telegram' | 'feishu' | 'cli';

export interface Attachment {
  type: 'image' | 'file' | 'audio' | 'other';
}

export interface IncomingMessage {
  readonly platform: PlatformId;
  /** Telegram chat.id / 飞书 chat_id / REPL 固定值；一律 string */
  readonly chatId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly isGroup: boolean;
  /** 私聊恒 true；群聊 = 被 @ 或被回复 bot 消息，判定在适配器内完成 */
  readonly isTargeted: boolean;
  /** 纯文本，已剥离 "@botname" 前缀 */
  readonly text: string;
  readonly attachments: readonly Attachment[];
  /** 原始 payload，逃生舱口 */
  readonly raw: unknown;
  reply(text: string): Promise<void>;
  startStreamReply(): Promise<StreamReplyHandle>;
  /**
   * 下载本消息中的图片并转为 base64 data URL（仅 image 类型；无图片返回空数组）。
   * 由 core 在组装多模态请求时按需调用，实现细节（鉴权/下载/编码）在适配器内。
   */
  getAttachmentDataUrls(): Promise<string[]>;
}

export interface StreamReplyHandle {
  /** 增量追加；节流封装在适配器内部 */
  append(delta: string): Promise<void>;
  /** 定稿（最后一次全量更新） */
  finish(): Promise<void>;
  /** 异常收尾（向用户展示错误文案、清理占位） */
  abort(err: Error): Promise<void>;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  start(): Promise<void>;
  stop(): Promise<void>;
  setDispatcher(dispatch: (msg: IncomingMessage) => Promise<void>): void;
  /** 注册命令菜单（Telegram setMyCommands）；飞书无此概念可不实现 */
  registerCommands?(commands: readonly { name: string; description: string }[]): Promise<void>;
  /** 主动向指定会话推送文本（定时提醒等不经过收件消息的场景） */
  sendTo(chatId: string, text: string): Promise<void>;
}
