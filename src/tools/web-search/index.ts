import { ChatCooldown } from '../cooldown';
import type { ToolSpec } from '../types';
import { TavilyHttpError, type SearchProvider } from './tavily';

/** 单条结果 content 截断，防搜索结果撑爆小上下文模型 */
const MAX_RESULT_CONTENT_CHARS = 500;

/** Tavily 的 published_date 可能是 ISO（取日期段）也可能是 RFC 长格式（原样保留） */
function formatDate(published?: string): string {
  if (!published) return '';
  const iso = published.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? (iso[1] as string) : published.trim();
}

export interface WebSearchToolOptions {
  provider: SearchProvider;
  maxResults: number;
  cooldownMinutes: number;
  /** 缺省 Date.now；测试注入假时钟 */
  now?: () => number;
}

/**
 * web_search 工具：跨轮按 `${platform}:${chatId}` 冷却（群聊私聊同规则，护搜索源免费额度）；
 * 同一轮（turnId 相同）的 agent 连招放行——搜→读→再搜是合法组合，不该被冷却腰斩。
 */
export function createWebSearchTool(opts: WebSearchToolOptions): ToolSpec {
  const now = opts.now ?? Date.now;
  const cooldown = new ChatCooldown(opts.cooldownMinutes * 60_000, now);

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
      const remainSec = cooldown.check(key, ctx.turnId);
      if (remainSec !== undefined) {
        ctx.log.info({ platform: ctx.platform, chatId: ctx.chatId, remainSec }, 'web_search 冷却命中');
        return (
          `web_search 处于冷却中：本会话距上次搜索不足 ${opts.cooldownMinutes} 分钟，剩余约 ${remainSec} 秒。` +
          '请告知用户稍后再试，或直接基于已有知识回答。'
        );
      }
      cooldown.mark(key, ctx.turnId);

      const started = Date.now();
      try {
        const results = await opts.provider.search(query, {
          maxResults: opts.maxResults,
          signal: ctx.signal,
        });
        // 搜索质量排查靠这条：query 由模型自由组装，不同会话措辞不同，召回差异大
        ctx.log.info(
          { query, results: results.length, tookMs: Date.now() - started },
          'web_search 完成',
        );
        if (results.length === 0) {
          return `未搜索到与「${query}」相关的结果。请基于已有知识回答，并说明未能获取实时信息。`;
        }
        return results
          .map((r, i) => {
            const date = formatDate(r.publishedDate);
            return `[${i + 1}] ${r.title}${date ? `（发布：${date}）` : ''}\n${r.url}\n${r.content.slice(0, MAX_RESULT_CONTENT_CHARS)}`;
          })
          .join('\n\n');
      } catch (err) {
        ctx.log.warn({ err, query }, 'web_search 执行失败');
        // 到达服务的失败（HTTP 4xx/5xx）可能已计费，烧冷却窗；连接层失败（超时/DNS）未计费，
        // 回滚窗口让模型可以立即重试，否则一次网络抖动就让用户 5 分钟搜不了
        if (err instanceof TavilyHttpError) {
          return `web_search 执行失败：${err.message}。请基于已有知识回答，并告知用户搜索暂时不可用。`;
        }
        cooldown.release(key);
        return `web_search 执行失败（网络未连通）：${err instanceof Error ? err.message : String(err)}。可稍等片刻重试一次；仍失败则基于已有知识回答，并告知用户网络暂不可用。`;
      }
    },
  };
}
