import OpenAI from 'openai';
import type { Dispatcher } from 'undici';
import type { ChatMessage, ChatOptions, LLMProvider } from './types';

export interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** 测试注入用；生产走全局 fetch */
  fetch?: typeof fetch;
  /** 代理出站（HTTP(S)_PROXY 环境变量），经 undici dispatcher 显式注入 */
  dispatcher?: Dispatcher;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;
  private readonly client: OpenAI;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.client = new OpenAI({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey,
      maxRetries: 2,
      fetch: opts.fetch,
      fetchOptions: opts.dispatcher ? { dispatcher: opts.dispatcher } : undefined,
    });
  }

  async *streamChat(messages: readonly ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: opts.model,
        // openai SDK 的消息类型按 role 拆分为联合变体，此处统一断言；content 形状由 MessageContent 保证
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })) as OpenAI.ChatCompletionMessageParam[],
        stream: true,
      },
      { signal: opts.signal },
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  async chat(messages: readonly ChatMessage[], opts: ChatOptions): Promise<string> {
    let out = '';
    for await (const delta of this.streamChat(messages, opts)) {
      out += delta;
    }
    return out;
  }
}
