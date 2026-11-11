import type { ToolContext, ToolSpec } from '../tools/types';
import { formatDisplay } from '../reminders/parse';
import type { ReminderService } from '../reminders/service';
import type { BroadcastService } from '../broadcasts/service';

export interface ListScheduleToolOptions {
  reminders?: ReminderService;
  broadcasts?: BroadcastService;
  timezone?: string;
}

/**
 * list_schedule 工具：实时查询当前会话的定时提醒与每日播报。
 * 清单类问题（「我挂着什么」「XX 还在吗」）凭记忆回答必然掺入旧快照——
 * 必须以本工具的实时查询结果为准。
 */
export function createListScheduleTool(opts: ListScheduleToolOptions): ToolSpec {
  return {
    name: 'list_schedule',
    description:
      '实时查询当前会话的定时提醒与每日播报清单。当用户问「我挂着哪些提醒/播报」「我有哪些定时任务」' +
      '「XX 提醒还在吗」，或回答涉及当前定时清单内容时调用——这类问题必须以本工具的实时结果为准，' +
      '不要凭对话记忆回答（记忆里的清单可能已过期或已触发）。',
    parameters: { type: 'object', properties: {} },
    async exec(_args: unknown, ctx: ToolContext) {
      const sections: string[] = [];
      const asOf = formatDisplay(Date.now(), opts.timezone);
      if (opts.reminders) {
        const list = opts.reminders.listByChat(ctx.chatId);
        if (list.length > 0) {
          const lines = list.map(
            (r) =>
              `${r.id} · 提醒于 ${formatDisplay(r.dueAt, opts.timezone)} · 创建于 ${formatDisplay(r.createdAt, opts.timezone)} · ${r.text}`,
          );
          sections.push(`【定时提醒】\n${lines.join('\n')}\n用 /unremind <id> 取消。`);
        }
      }
      if (opts.broadcasts) {
        const list = opts.broadcasts.listByChat(ctx.chatId);
        if (list.length > 0) {
          const lines = list.map((b) => `${b.id} · 每天 ${b.time} · ${b.query}`);
          sections.push(`【每日播报】\n${lines.join('\n')}\n用 /unbroadcast <id> 取消。`);
        }
      }
      if (sections.length === 0) {
        return `截至 ${asOf}，当前会话没有任何定时提醒或每日播报。`;
      }
      return `截至 ${asOf} 的实时清单：\n\n${sections.join('\n\n')}`;
    },
  };
}
