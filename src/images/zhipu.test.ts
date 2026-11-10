import { describe, expect, it } from 'vitest';
import { createZhipuImageProvider } from './zhipu';

function makeFake(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  };
  return { fakeFetch, calls };
}

describe('createZhipuImageProvider', () => {
  it('POST 到 /images/generations 且携带 model 与 prompt，返回 url', async () => {
    const { fakeFetch, calls } = makeFake(
      200,
      JSON.stringify({ created: 1, data: [{ url: 'https://sfile.chatglm.cn/a.png' }] }),
    );
    const provider = createZhipuImageProvider({ apiKey: 'zk-test', fetch: fakeFetch });
    const image = await provider.generate('戴墨镜的猫');
    expect(calls[0]?.url).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations');
    const payload = JSON.parse(String(calls[0]?.init.body)) as { model: string; prompt: string };
    expect(payload.model).toBe('cogview-3-flash');
    expect(payload.prompt).toBe('戴墨镜的猫');
    expect(calls[0]?.init.method).toBe('POST');
    expect(image.url).toBe('https://sfile.chatglm.cn/a.png');
  });

  it('baseUrl 覆盖默认端点', async () => {
    const { fakeFetch, calls } = makeFake(200, JSON.stringify({ data: [{ url: 'u' }] }));
    const provider = createZhipuImageProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:9999/v4',
      fetch: fakeFetch,
    });
    await provider.generate('q');
    expect(calls[0]?.url).toBe('http://localhost:9999/v4/images/generations');
  });

  it('非 2xx 抛 ZhipuHttpError 且携带状态码', async () => {
    const { fakeFetch } = makeFake(429, 'busy');
    const provider = createZhipuImageProvider({ apiKey: 'k', fetch: fakeFetch });
    await expect(provider.generate('q')).rejects.toThrow(/429.*busy/s);
  });

  it('data 为空时抛错', async () => {
    const { fakeFetch } = makeFake(200, JSON.stringify({ data: [] }));
    const provider = createZhipuImageProvider({ apiKey: 'k', fetch: fakeFetch });
    await expect(provider.generate('q')).rejects.toThrow(/未返回图片链接/);
  });
});
