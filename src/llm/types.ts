/** 多模态内容段：文本与图片（图片以 base64 data URL 内联） */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type MessageContent = string | ContentPart[];

/** 完整累积后的单次工具调用；增量分片的重组在 provider 层完成 */
export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 串，解析归工具执行层 */
  arguments: string;
}

/** 流式事件：文本增量即时产出；工具调用在流结束后按协议顺序一次性给出 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'finish'; reason: string };

/** openai function tools 的 wire 形状 */
export interface FunctionToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  /** role='assistant' 发起工具调用时携带 */
  tool_calls?: ToolCall[];
  /** role='tool' 时对应被回传的调用 id */
  tool_call_id?: string;
}

export interface ChatOptions {
  model: string;
  signal?: AbortSignal;
  /** 缺省/空 = 不带工具 */
  tools?: readonly FunctionToolDef[];
}

export interface LLMProvider {
  readonly id: string;
  /** 产出结构化流式事件：文本增量、完整工具调用、结束原因 */
  streamChat(messages: readonly ChatMessage[], opts: ChatOptions): AsyncIterable<StreamEvent>;
  /** 聚合文本事件返回全文；仅用于无工具的辅助调用（compact / 记忆提取），工具事件会被丢弃 */
  chat(messages: readonly ChatMessage[], opts: ChatOptions): Promise<string>;
}
