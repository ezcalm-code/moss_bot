import { describe, expect, it } from 'vitest';
import { createTavilyProvider } from './tavily';

function makeFake(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  };
  return { fakeFetch, calls };
}

const OK_BODY = JSON.stringify({
  results: [
    { title: '标题A', url: 'https://a.example', content: '内容A内容A', published_date: '2026-11-08T21:30:00Z' },
    { title: '标题B', url: 'https://b.example' },
  ],
});

describe('createTavilyProvider', () => {
  it('POST 到 /search 且 body 携带 api_key/query/max_results', async () => {
    const { fakeFetch, calls } = makeFake(200, OK_BODY);
    const provider = createTavilyProvider({ apiKey: 'tvly-k', fetch: fakeFetch });
    const results = await provider.search('北京天气', { maxResults: 3 });
    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      api_key: 'tvly-k',
      query: '北京天气',
      max_results: 3,
    });
    expect(results).toEqual([
      { title: '标题A', url: 'https://a.example', content: '内容A内容A', publishedDate: '2026-11-08T21:30:00Z' },
      { title: '标题B', url: 'https://b.example', content: '', publishedDate: undefined },
    ]);
  });

  it('baseUrl 覆盖默认端点', async () => {
    const { fakeFetch, calls } = makeFake(200, OK_BODY);
    const provider = createTavilyProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:9999',
      fetch: fakeFetch,
    });
    await provider.search('q', { maxResults: 1 });
    expect(calls[0]?.url).toBe('http://localhost:9999/search');
  });

  it('非 2xx 抛错且携带状态码与响应片段', async () => {
    const { fakeFetch } = makeFake(500, 'boom-body');
    const provider = createTavilyProvider({ apiKey: 'k', fetch: fakeFetch });
    await expect(provider.search('q', { maxResults: 1 })).rejects.toThrow(/500.*boom-body/s);
  });

  it('results 缺失时返回空数组', async () => {
    const { fakeFetch } = makeFake(200, '{}');
    const provider = createTavilyProvider({ apiKey: 'k', fetch: fakeFetch });
    expect(await provider.search('q', { maxResults: 5 })).toEqual([]);
  });
});
