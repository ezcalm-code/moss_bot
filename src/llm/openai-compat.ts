import OpenAI from 'openai';
import type { Dispatcher } from 'undici';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall } from './types';

export interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  /** 测试注入用；生产走全局 fetch */
  fetch?: typeof fetch;
  /** 代理出站（HTTP(S)_PROXY 环境变量），经 undici dispatcher 显式注入 */
  dispatcher?: Dispatcher;
}

interface ToolAccum {
  id?: string;
  name: string;
  args: string;
}

/** ChatMessage → openai wire 消息；tool 角色与 assistant.tool_calls 是 function calling 协议扩展 */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.tool_calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
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

  async *streamChat(
    messages: readonly ChatMessage[],
    opts: ChatOptions,
  ): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: opts.model,
        // openai SDK 的消息/工具类型按 role 拆分为联合变体，此处统一断言；content 形状由 MessageContent 保证
        messages: messages.map(toWireMessage) as unknown as OpenAI.ChatCompletionMessageParam[],
        ...(opts.tools?.length
          ? { tools: opts.tools as unknown as OpenAI.ChatCompletionTool[] }
          : {}),
        stream: true,
      },
      { signal: opts.signal },
    );
    // tool_calls 以增量分片下发（name/arguments 可能被切开，个别网关连 id 都不带）：
    // 按 index 累积，流结束后一次性重组产出——重组细节不外泄
    const accums = new Map<number, ToolAccum>();
    let finish = 'stop';
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: 'text', text: choice.delta.content };
      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const acc = accums.get(idx) ?? { name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        accums.set(idx, acc);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const ordered = [...accums.entries()].sort(([a], [b]) => a - b);
    for (const [idx, acc] of ordered) {
      const call: ToolCall = { id: acc.id ?? `call_${idx}`, name: acc.name, arguments: acc.args };
      yield { type: 'tool_call', call };
    }
    yield { type: 'finish', reason: finish };
  }

  async chat(messages: readonly ChatMessage[], opts: ChatOptions): Promise<string> {
    let out = '';
    for await (const evt of this.streamChat(messages, opts)) {
      if (evt.type === 'text') out += evt.text;
    }
    return out;
  }
}
