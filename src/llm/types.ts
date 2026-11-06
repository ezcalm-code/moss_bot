export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
