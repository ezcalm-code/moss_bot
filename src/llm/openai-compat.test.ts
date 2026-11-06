import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from './openai-compat';

const CHUNK_TEMPLATE = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'test-model',
  choices: [{ index: 0, delta: {}, finish_reason: null }],
};

function sseChunk(content: string | undefined): string {
  const chunk = structuredClone(CHUNK_TEMPLATE);
  (chunk.choices[0] as { delta: Record<string, string> }).delta =
    content === undefined ? {} : { content };
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

describe('OpenAICompatProvider', () => {
  it('SSE 流被正确聚合为 delta 序列', async () => {
    const body =
      sseChunk('你') + sseChunk('好') + sseChunk('，') + sseChunk('Moss') + 'data: [DONE]\n\n';
    const { provider } = makeProvider(body);
    const deltas: string[] = [];
    for await (const delta of provider.streamChat([{ role: 'user', content: 'hi' }], {
      model: 'test-model',
    })) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['你', '好', '，', 'Moss']);
    expect(deltas.join('')).toBe('你好，Moss');
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
});
