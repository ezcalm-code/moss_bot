import type { Dispatcher } from 'undici';
import type { PageExtractor } from '../types';

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

/** 请求已到达 Tavily 且被 HTTP 拒绝；与连接层失败（超时/DNS，未计费）区分开 */
export class TavilyHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createTavilyProvider(opts: TavilyOptions): SearchProvider {
  const base = opts.baseUrl ?? 'https://api.tavily.com';
  return {
    id: 'tavily',
    async search(query, { maxResults, signal }) {
      const data = await tavilyPost(opts, base, '/search', {
        api_key: opts.apiKey,
        query,
        max_results: maxResults,
      }, signal);
      return (data.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        content: r.content ?? '',
        publishedDate: r.published_date || undefined,
      }));
    },
  };
}

/** read_url 工具的后端：Tavily Extract 抓取网页正文（免自建 HTML 解析，与搜索共用 key） */
export function createTavilyExtractor(opts: TavilyOptions): PageExtractor {
  const base = opts.baseUrl ?? 'https://api.tavily.com';
  return {
    id: 'tavily-extract',
    async extract(url) {
      const data = await tavilyPost(opts, base, '/extract', {
        api_key: opts.apiKey,
        urls: [url],
      });
      const item = data.results?.[0];
      const content = item?.raw_content?.trim();
      if (!content) {
        const failed = data.failed_results?.[0]?.error ?? '页面无可提取的正文';
        throw new Error(failed.slice(0, 200));
      }
      return content;
    },
  };
}

async function tavilyPost(
  opts: TavilyOptions,
  base: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  results?: { title?: string; url?: string; content?: string; raw_content?: string; published_date?: string }[];
  failed_results?: { url?: string; error?: string }[];
}> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    dispatcher: opts.dispatcher,
  } as RequestInit;
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${base}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    throw new TavilyHttpError(res.status, `Tavily HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}
