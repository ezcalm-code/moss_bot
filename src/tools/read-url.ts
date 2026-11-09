import type { PageExtractor, ToolSpec } from './types';

export interface ReadUrlToolOptions {
  extractor: PageExtractor;
  /** 正文截断上限，防长文撑爆上下文 */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 6000;

/**
 * read_url 工具：用户发来链接并希望了解/讨论其内容时，抓取网页全文给模型。
 * 用户驱动的低频行为，v1 不设冷却；触发条件写死在 description 里，与 web_search 互补不重叠。
 */
export function createReadUrlTool(opts: ReadUrlToolOptions): ToolSpec {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  return {
    name: 'read_url',
    description:
      '读取用户发来的网页链接的正文内容。当用户粘贴了 URL（http/https 链接）并希望你看完内容、' +
      '总结、评价或讨论时调用。注意：需要搜索获取信息时用 web_search，不要用本工具搜索；' +
      '用户没发链接时不要凭空构造 URL 调用。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要读取的完整网页链接' } },
      required: ['url'],
    },
    async exec(args, ctx) {
      const raw = typeof (args as { url?: unknown })?.url === 'string'
        ? (args as { url: string }).url.trim()
        : '';
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return 'read_url 参数错误：url 必须是合法的完整链接（含 http(s):// 前缀）。请向用户确认链接后重试。';
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'read_url 参数错误：只支持 http/https 链接。';
      }
      try {
        const content = await opts.extractor.extract(raw);
        ctx.log.info({ url: raw, chars: content.length }, 'read_url 完成');
        if (!content) {
          return `链接 ${raw} 没有可提取的正文（可能是纯视频/图片页）。请告知用户无法读取该页面。`;
        }
        return `[链接] ${raw}\n\n${content.slice(0, maxChars)}`;
      } catch (err) {
        ctx.log.warn({ err, url: raw }, 'read_url 执行失败');
        return `read_url 执行失败：${err instanceof Error ? err.message : String(err)}。请告知用户该链接暂时读不了。`;
      }
    },
  };
}
