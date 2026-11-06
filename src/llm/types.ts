/** 多模态内容段：文本与图片（图片以 base64 data URL 内联） */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface ChatOptions {
  model: string;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  /** 逐 delta 产出文本增量 */
  streamChat(messages: readonly ChatMessage[], opts: ChatOptions): AsyncIterable<string>;
  /** 便捷方法：聚合 streamChat 返回全文 */
  chat(messages: readonly ChatMessage[], opts: ChatOptions): Promise<string>;
}
