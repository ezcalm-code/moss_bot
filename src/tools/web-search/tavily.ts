import type { Dispatcher } from 'undici';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  /** 发布时间（源提供才有）；无日期的内容模型无法判断时效，会混入过期信息 */
  publishedDate?: string;
}

/** 搜索源可插拔接口：SearXNG 等自托管源实现同款即可接入 */
export interface SearchProvider {
  readonly id: string;
  search(query: string, opts: { maxResults: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export interface TavilyOptions {
  apiKey: string;
  /** 缺省 https://api.tavily.com */
  baseUrl?: string;
  /** 测试注入用；生产走全局 fetch */
  fetch?: typeof fetch;
  /** 代理出站，与 OpenAICompatOptions.dispatcher 同款注入方式 */
  dispatcher?: Dispatcher;
}

export function createTavilyProvider(opts: TavilyOptions): SearchProvider {
  const base = opts.baseUrl ?? 'https://api.tavily.com';
  return {
    id: 'tavily',
    async search(query, { maxResults, signal }) {
      // dispatcher 用整对象 as RequestInit：npm undici 与 Node 内置 undici-types 的 Dispatcher
      // 类型不互通，字段级合并（RequestInit & {dispatcher}）会被判不可比（与 telegram 适配器同款处理）
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: opts.apiKey, query, max_results: maxResults }),
        signal,
        dispatcher: opts.dispatcher,
      } as RequestInit;
      const doFetch = opts.fetch ?? fetch;
      const res = await doFetch(`${base}/search`, init);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = JSON.parse(text) as {
        results?: { title?: string; url?: string; content?: string; published_date?: string }[];
      };
      return (data.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        publishedDate: r.published_date || undefined,
      }));
    },
  };
}
