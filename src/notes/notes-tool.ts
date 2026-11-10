import type { ToolContext, ToolSpec } from '../tools/types';
import type { NotesService } from './service';

export interface AddNoteToolOptions {
  service: NotesService;
}

/** add_note 工具：用户口述记笔记（「帮我记个笔记：xxx」）的自然语言入口 */
export function createAddNoteTool(opts: AddNoteToolOptions): ToolSpec {
  return {
    name: 'add_note',
    description:
      '把用户口述的内容记成一条加密笔记（如账号信息、地址、配置、编号等用户想让你替他存的东西）。' +
      '当用户明确说「记个笔记 / 帮我记一下 / 存起来」并给出内容时调用；' +
      '只是闲聊提到的信息不要调用；定时类请求用 schedule_reminder，不要混用。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '笔记内容，尽量保留用户原话' } },
      required: ['text'],
    },
    async exec(args: unknown, ctx: ToolContext) {
      const text = typeof (args as { text?: unknown })?.text === 'string'
        ? (args as { text: string }).text.trim()
        : '';
      if (!text) {
        return 'add_note 参数错误：text 必须是非空字符串。请向用户确认要记的内容。';
      }
      try {
        const userId = `${ctx.platform}:${ctx.senderId}`;
        const note = opts.service.add(userId, text);
        ctx.log.info({ id: note.id, chatId: ctx.chatId }, 'add_note 设置成功');
        return `已记下加密笔记（id: ${note.id}）：${text}。用户可用 /notes 命令查看自己的全部笔记。请告知用户已记好。`;
      } catch (err) {
        ctx.log.warn({ err }, 'add_note 执行失败');
        return `add_note 执行失败：${err instanceof Error ? err.message : String(err)}。请告知用户。`;
      }
    },
  };
}
