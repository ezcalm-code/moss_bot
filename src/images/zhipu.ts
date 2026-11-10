import type { Dispatcher } from 'undici';
import type { ImageProvider } from './types';

export interface ZhipuImageOptions {
  apiKey: string;
  /** 缺省 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl?: string;
  /** 缺省 cogview-3-flash（官方免费档） */
  model?: string;
  /** 测试注入用；生产走全局 fetch */
  fetch?: typeof fetch;
  /** 代理出站，与 OpenAICompatOptions.dispatcher 同款注入方式 */
  dispatcher?: Dispatcher;
}

/** 请求已到达智谱且被 HTTP 拒绝（与连接层失败区分，供上层决定是否烧冷却） */
export class ZhipuHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createZhipuImageProvider(opts: ZhipuImageOptions): ImageProvider {
  const base = opts.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
  const model = opts.model ?? 'cogview-3-flash';
  return {
    id: 'zhipu-image',
    async generate(prompt, { signal } = {}) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model, prompt }),
        signal,
        dispatcher: opts.dispatcher,
      } as RequestInit;
      const doFetch = opts.fetch ?? fetch;
      const res = await doFetch(`${base}/images/generations`, init);
      const text = await res.text();
      if (!res.ok) {
        throw new ZhipuHttpError(res.status, `智谱生图 HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = JSON.parse(text) as { data?: { url?: string }[] };
      const url = data.data?.[0]?.url;
      if (!url) {
        throw new Error('智谱生图未返回图片链接');
      }
      return { url };
    },
  };
}
