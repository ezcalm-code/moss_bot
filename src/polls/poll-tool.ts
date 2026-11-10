import type { ToolContext, ToolSpec } from '../tools/types';
import type { PollsService } from './service';

export interface CreatePollToolOptions {
  service: PollsService;
}

/** create_poll 工具：自然语言发起投票的入口——拆问题和选项是语言任务，归模型；校验归代码 */
export function createCreatePollTool(opts: CreatePollToolOptions): ToolSpec {
  return {
    name: 'create_poll',
    description:
      '在当前会话发起投票。当用户想收集大家对某个问题的选择时调用（如「发起个投票，今晚吃什么，火锅还是烧烤」「投个票，周末去爬山还是在家」）。' +
      'question 是投票问题本身；options 从用户的话里拆出候选项（「A还是B」「A 或 B」、顿号列举等都算），保持选项简短；' +
      '2-6 个选项。用户只是问到投票功能怎么用、并没有要发起时，不要调用。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '投票问题' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '候选项，2-6 个，每项简短',
        },
      },
      required: ['question', 'options'],
    },
    async exec(args: unknown, ctx: ToolContext) {
      const { question, options } = (args ?? {}) as { question?: unknown; options?: unknown };
      const optionList = Array.isArray(options)
        ? options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map((o) => o.trim())
        : [];
      if (typeof question !== 'string' || !question.trim() || optionList.length < 2 || optionList.length > 6) {
        return 'create_poll 参数错误：需要 question 与 2-6 个非空 options。请向用户确认问题与候选项后重试。';
      }
      try {
        await opts.service.createPoll(ctx.platform, ctx.chatId, question.trim(), optionList);
        return `投票已发起：「${question.trim()}」 共 ${optionList.length} 个选项。请告知用户投票已发出。`;
      } catch (err) {
        return `create_poll 执行失败：${err instanceof Error ? err.message : String(err)}。请告知用户。`;
      }
    },
  };
}
