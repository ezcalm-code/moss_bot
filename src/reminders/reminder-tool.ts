import type { ToolContext, ToolSpec } from '../tools/types';
import type { ReminderService } from './service';

export interface ReminderToolOptions {
  service: ReminderService;
}

/**
 * schedule_reminder 工具：自然语言路径的定时提醒。
 * 「明早9点」这类相对时间由模型推算（system prompt 已注入当天日期），有效性校验归代码。
 */
export function createReminderTool(opts: ReminderToolOptions): ToolSpec {
  return {
    name: 'schedule_reminder',
    description:
      '设置定时提醒，到时间点主动给当前会话推送一条消息。当用户要求「X点提醒我做Y」「X分钟后叫我Z」时调用。' +
      'datetime 用本地时间的 ISO 格式（如 2026-11-10T09:00），由你根据今天的日期与用户的说法推算；' +
      'text 是提醒内容，保持用户原话的意思。不是提醒类请求不要调用。',
    parameters: {
      type: 'object',
      properties: {
        datetime: { type: 'string', description: '提醒时间，本地时间 ISO 格式，如 2026-11-10T09:00' },
        text: { type: 'string', description: '提醒内容' },
      },
      required: ['datetime', 'text'],
    },
    async exec(args, ctx: ToolContext) {
      const { datetime, text } = (args ?? {}) as { datetime?: unknown; text?: unknown };
      if (typeof datetime !== 'string' || typeof text !== 'string' || !text.trim()) {
        return 'schedule_reminder 参数错误：需要 datetime（本地时间 ISO 格式）与非空 text。请修正后重试。';
      }
      const dueAt = new Date(datetime).getTime();
      if (Number.isNaN(dueAt)) {
        return `schedule_reminder 参数错误：无法把「${datetime}」解析成时间。请按 ISO 格式（YYYY-MM-DDTHH:MM）重试。`;
      }
      try {
        const reminder = opts.service.add({
          platform: ctx.platform,
          chatId: ctx.chatId,
          senderName: ctx.senderName || '用户',
          text: text.trim(),
          dueAt,
        });
        ctx.log.info(
          { id: reminder.id, chatId: ctx.chatId, dueAt: reminder.dueAt },
          'schedule_reminder 设置成功',
        );
        return `已设置提醒（id: ${reminder.id}），将在 ${new Date(dueAt).toLocaleString()} 通过当前会话推送：「${text.trim()}」。请告知用户已设好。`;
      } catch (err) {
        return `schedule_reminder 执行失败：${err instanceof Error ? err.message : String(err)}。请把错误原因告知用户。`;
      }
    },
  };
}
