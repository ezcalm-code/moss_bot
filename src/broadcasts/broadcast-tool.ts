import type { ToolContext, ToolSpec } from '../tools/types';
import type { BroadcastService } from './service';

export interface ScheduleBroadcastToolOptions {
  service: BroadcastService;
}

/** schedule_broadcast 工具：自然语言设置每日定时播报（「每天早上9点给我推AI新闻」） */
export function createScheduleBroadcastTool(opts: ScheduleBroadcastToolOptions): ToolSpec {
  return {
    name: 'schedule_broadcast',
    description:
      '设置每日定时播报：每天在固定时间自动执行一次搜索并推送摘要到当前会话。' +
      '当用户要求「每天X点给我推/播报Y」这类周期性订阅时调用；一次性提醒用 schedule_reminder，不要混用。' +
      'time 用 HH:MM 24 小时制；query 是每天要搜索的主题关键词。',
    parameters: {
      type: 'object',
      properties: {
        time: { type: 'string', description: '每日推送时刻，HH:MM 24 小时制' },
        query: { type: 'string', description: '每日搜索的主题关键词' },
      },
      required: ['time', 'query'],
    },
    async exec(args: unknown, ctx: ToolContext) {
      const { time, query } = (args ?? {}) as { time?: unknown; query?: unknown };
      if (typeof time !== 'string' || typeof query !== 'string' || !query.trim()) {
        return 'schedule_broadcast 参数错误：需要 time（HH:MM）与非空 query。请修正后重试。';
      }
      try {
        const b = opts.service.add({
          platform: ctx.platform,
          chatId: ctx.chatId,
          time,
          query: query.trim(),
        });
        ctx.log.info({ id: b.id, chatId: ctx.chatId, time: b.time }, 'schedule_broadcast 设置成功');
        return `已设置每日播报（id: ${b.id}）：每天 ${b.time} 自动搜索「${b.query.trim()}」并推送摘要到当前会话。请告知用户已设好。`;
      } catch (err) {
        return `schedule_broadcast 执行失败：${err instanceof Error ? err.message : String(err)}。请把原因告知用户。`;
      }
    },
  };
}
