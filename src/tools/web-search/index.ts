import type { ToolSpec } from '../types';
import type { SearchProvider } from './tavily';

/** 单条结果 content 截断，防搜索结果撑爆小上下文模型 */
const MAX_RESULT_CONTENT_CHARS = 500;

export interface WebSearchToolOptions {
  provider: SearchProvider;
  maxResults: number;
  cooldownMinutes: number;
  /** 缺省 Date.now；测试注入假时钟 */
  now?: () => number;
}

/**
 * web_search 工具：按 `${platform}:${chatId}` 冷却（群聊私聊同规则，护搜索源免费额度）。
 * 写入冷却时间先于搜索调用——失败也烧窗口，防止网络抖动反复重试烧穿配额。
 */
export function createWebSearchTool(opts: WebSearchToolOptions): ToolSpec {
  const cooldownMs = opts.cooldownMinutes * 60_000;
  const now = opts.now ?? Date.now;
  const lastUsed = new Map<string, number>();

  return {
    name: 'web_search',
    description:
      '搜索互联网，获取实时或时效性信息（新闻、天气、价格、赛事、版本发布等）。' +
      '只在当前知识无法回答、且答案会随时间变化时调用；闲聊、常识、代码问题不要调用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词，用与用户相同的语言' } },
      required: ['query'],
    },
    async exec(args, ctx) {
      const query = typeof (args as { query?: unknown })?.query === 'string'
        ? (args as { query: string }).query.trim()
        : '';
      if (!query) {
        return 'web_search 参数错误：query 必须是非空字符串。请修正后重试，或直接基于已有知识回答。';
      }

      const key = `${ctx.platform}:${ctx.chatId}`;
      for (const [k, t] of lastUsed) {
        if (now() - t >= cooldownMs) lastUsed.delete(k);
      }
      const last = lastUsed.get(key);
      if (last !== undefined && now() - last < cooldownMs) {
        const remainSec = Math.ceil((cooldownMs - (now() - last)) / 1000);
        return (
          `web_search 处于冷却中：本会话距上次搜索不足 ${opts.cooldownMinutes} 分钟，剩余约 ${remainSec} 秒。` +
          '请告知用户稍后再试，或直接基于已有知识回答。'
        );
      }
      lastUsed.set(key, now());

      try {
        const results = await opts.provider.search(query, {
          maxResults: opts.maxResults,
          signal: ctx.signal,
        });
        if (results.length === 0) {
          return `未搜索到与「${query}」相关的结果。请基于已有知识回答，并说明未能获取实时信息。`;
        }
        return results
          .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content.slice(0, MAX_RESULT_CONTENT_CHARS)}`)
          .join('\n\n');
      } catch (err) {
        ctx.log.warn({ err, query }, 'web_search 执行失败');
        return `web_search 执行失败：${err instanceof Error ? err.message : String(err)}。请基于已有知识回答，并告知用户搜索暂时不可用。`;
      }
    },
  };
}
