import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from './openai-compat';
import type { ChatMessage, FunctionToolDef, StreamEvent } from './types';

const CHUNK_TEMPLATE = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, delta: {}, finish_reason: null }],
};

interface ToolDeltaPart {
  index: number;
  id?: string;
  name?: string;
  args?: string;
}

function sseChunk(
  content: string | undefined,
  extra?: { toolCalls?: ToolDeltaPart[]; finish?: string },
): string {
  const chunk = structuredClone(CHUNK_TEMPLATE);
  const delta: Record<string, unknown> = content === undefined ? {} : { content };
  if (extra?.toolCalls) {
    delta.tool_calls = extra.toolCalls.map((p) => ({
      index: p.index,
      ...(p.id ? { id: p.id } : {}),
      type: 'function',
      function: { ...(p.name ? { name: p.name } : {}), ...(p.args ? { arguments: p.args } : {}) },
    }));
  }
  (chunk.choices[0] as { delta: Record<string, unknown> }).delta = delta;
  if (extra?.finish) {
    (chunk.choices[0] as unknown as { finish_reason: string }).finish_reason = extra.finish;
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function sseResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeProvider(body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return sseResponse(body);
  };
  const provider = new OpenAICompatProvider({
    id: 'test',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'sk-test',
    fetch: fakeFetch,
  });
  return { provider, calls };
}

async function collect(
  provider: OpenAICompatProvider,
  messages: ChatMessage[] = [{ role: 'user', content: 'hi' }],
  opts?: { tools?: FunctionToolDef[] },
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const evt of provider.streamChat(messages, { model: 'test-model', ...opts })) {
    events.push(evt);
  }
  return events;
}

const SEARCH_TOOL: FunctionToolDef = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

describe('OpenAICompatProvider', () => {
  it('SSE 流被正确聚合为 text 事件序列', async () => {
    const body =
      sseChunk('你') + sseChunk('好') + sseChunk('，') + sseChunk('Moss') + 'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    expect(events).toEqual([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'text', text: '，' },
      { type: 'text', text: 'Moss' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('空 delta 的 chunk 被跳过', async () => {
    const body = sseChunk(undefined) + sseChunk('a') + sseChunk(undefined) + 'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const text = await provider.chat([{ role: 'user', content: 'hi' }], { model: 'm' });
    expect(text).toBe('a');
  });

  it('请求发往 baseUrl/chat/completions 且携带 model 与 stream=true', async () => {
    const { provider, calls } = makeProvider('data: [DONE]\n\n');
    await provider.chat([{ role: 'user', content: 'hi' }], { model: 'grok-4-mini' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:1234/v1/chat/completions');
    const payload = JSON.parse(String(calls[0]?.init.body ?? '{}')) as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    expect(payload.model).toBe('grok-4-mini');
    expect(payload.stream).toBe(true);
    expect(payload.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('tool_call 分片增量累积为完整调用，事件先于 finish', async () => {
    const body =
      sseChunk(undefined, {
        toolCalls: [{ index: 0, id: 'call_1', name: 'web_search', args: '{"qu' }],
      }) +
      sseChunk(undefined, { toolCalls: [{ index: 0, args: 'ery":"北京天气"}' }] }) +
      sseChunk(undefined, { finish: 'tool_calls' }) +
      'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    expect(events).toEqual([
      { type: 'tool_call', call: { id: 'call_1', name: 'web_search', arguments: '{"query":"北京天气"}' } },
      { type: 'finish', reason: 'tool_calls' },
    ]);
  });

  it('多个并行 tool_call 按 index 顺序产出', async () => {
    const body =
      sseChunk(undefined, {
        toolCalls: [
          { index: 0, id: 'a', name: 'web_search', args: '{"query":"a"}' },
          { index: 1, id: 'b', name: 'web_search', args: '{"query":"b"}' },
        ],
      }) +
      sseChunk(undefined, { finish: 'tool_calls' }) +
      'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    const calls = events
      .filter((e): e is Extract<StreamEvent, { type: 'tool_call' }> => e.type === 'tool_call')
      .map((e) => e.call);
    expect(calls).toEqual([
      { id: 'a', name: 'web_search', arguments: '{"query":"a"}' },
      { id: 'b', name: 'web_search', arguments: '{"query":"b"}' },
    ]);
  });

  it('content 与 tool_calls 同轮：text 即时产出，tool_call 延迟到流末', async () => {
    const body =
      sseChunk('我来搜一下') +
      sseChunk(undefined, { toolCalls: [{ index: 0, id: 'c1', name: 'web_search', args: '{"query":"x"}' }] }) +
      sseChunk(undefined, { finish: 'tool_calls' }) +
      'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    expect(events[0]).toEqual({ type: 'text', text: '我来搜一下' });
    expect(events[1]).toEqual({
      type: 'tool_call',
      call: { id: 'c1', name: 'web_search', arguments: '{"query":"x"}' },
    });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('finish_reason 缺失时补默认 stop', async () => {
    const body = sseChunk('hi') + 'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('tool_call 缺 id 时回退 call_{index}', async () => {
    const body =
      sseChunk(undefined, { toolCalls: [{ index: 2, name: 'web_search', args: '{}' }] }) +
      'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const events = await collect(provider);
    expect(events[0]).toEqual({
      type: 'tool_call',
      call: { id: 'call_2', name: 'web_search', arguments: '{}' },
    });
  });

  it('传 tools 时请求体带 tools，不传时无该键', async () => {
    const { provider, calls } = makeProvider('data: [DONE]\n\n');
    await collect(provider, [{ role: 'user', content: 'hi' }], { tools: [SEARCH_TOOL] });
    const withTools = JSON.parse(String(calls[0]?.init.body ?? '{}')) as { tools?: unknown[] };
    expect(withTools.tools).toHaveLength(1);
    expect(withTools.tools?.[0]).toEqual(SEARCH_TOOL);

    await collect(provider, [{ role: 'user', content: 'hi' }]);
    const withoutTools = JSON.parse(String(calls[1]?.init.body ?? '{}')) as { tools?: unknown };
    expect('tools' in withoutTools).toBe(false);
  });

  it('tool 消息与 assistant.tool_calls 按协议序列化，空 content 置 null', async () => {
    const { provider, calls } = makeProvider('data: [DONE]\n\n');
    const messages: ChatMessage[] = [
      { role: 'user', content: '今天天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_x', name: 'web_search', arguments: '{"query":"天气"}' }],
      },
      { role: 'tool', tool_call_id: 'call_x', content: '晴' },
    ];
    await collect(provider, messages);
    const payload = JSON.parse(String(calls[0]?.init.body ?? '{}')) as {
      messages: Record<string, unknown>[];
    };
    expect(payload.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"天气"}' },
        },
      ],
    });
    expect(payload.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_x', content: '晴' });
  });
});
