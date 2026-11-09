import type { IncomingMessage } from '../adapters/types';
import type { LlmRegistry } from '../llm/registry';
import { memoryKeyOf, type UserMemoryStore } from '../memory/store';
import { formatDisplay, parseRemindTime } from '../reminders/parse';
import type { ReminderService } from '../reminders/service';
import { texts } from '../text';
import type { SessionManager } from './session';

export interface CommandContext {
  readonly msg: IncomingMessage;
  /** "/model grok" → "grok"；无参为空串 */
  readonly args: string;
  reply(text: string): Promise<void>;
}

export interface CommandDeps {
  commands: CommandRegistry;
  registry: LlmRegistry;
  sessions: SessionManager;
  personaName: string;
  memory?: UserMemoryStore;
  reminders?: ReminderService;
}

export interface CommandSpec {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage?: string;
  visible: boolean;
  handler(ctx: CommandContext, deps: CommandDeps): Promise<void>;
}

/** 统一命令解析：支持 "/cmd@botname args" 形式（Telegram 群聊），命令名大小写不敏感 */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: (m[1] as string).toLowerCase(), args: (m[2] ?? '').trim() };
}

export class CommandRegistry {
  private readonly byName = new Map<string, CommandSpec>();

  constructor(specs: readonly CommandSpec[]) {
    for (const spec of specs) {
      this.byName.set(spec.name, spec);
      for (const alias of spec.aliases ?? []) {
        this.byName.set(alias, spec);
      }
    }
  }

  lookup(name: string): CommandSpec | undefined {
    return this.byName.get(name.toLowerCase());
  }

  visibleCommands(): CommandSpec[] {
    return [...new Set([...this.byName.values()].filter((s) => s.visible))];
  }

  /** 供 Telegram setMyCommands 使用 */
  menu(): { name: string; description: string }[] {
    return this.visibleCommands().map((c) => ({ name: c.name, description: c.description }));
  }
}

export function builtinCommands(): CommandSpec[] {
  return [
    {
      name: 'start',
      visible: false,
      description: '欢迎语',
      async handler(ctx, deps) {
        await ctx.reply(texts.welcome(deps.personaName));
      },
    },
    {
      name: 'help',
      visible: true,
      description: '显示可用命令',
      usage: '/help',
      async handler(ctx, deps) {
        const lines = deps.commands
          .visibleCommands()
          .map((c) => `${c.usage ?? `/${c.name}`} — ${c.description}`);
        await ctx.reply(`${texts.helpHeader}\n${lines.join('\n')}`);
      },
    },
    {
      name: 'models',
      visible: true,
      description: '列出可用模型',
      usage: '/models',
      async handler(ctx, deps) {
        const session = await deps.sessions.get(ctx.msg.platform, ctx.msg.chatId);
        const current = session.modelAlias ?? deps.registry.defaultAlias;
        const lines = deps.registry.entries.map(
          (e) => `${e.alias === current ? '●' : '○'} ${e.alias} (${e.model})`,
        );
        await ctx.reply(`可用模型（● 为当前）：\n${lines.join('\n')}`);
      },
    },
    {
      name: 'model',
      visible: true,
      description: '查看或切换模型',
      usage: '/model [alias]',
      async handler(ctx, deps) {
        const session = await deps.sessions.get(ctx.msg.platform, ctx.msg.chatId);
        if (!ctx.args) {
          await ctx.reply(texts.currentModel(session.modelAlias ?? deps.registry.defaultAlias));
          return;
        }
        try {
          deps.registry.entryFor(ctx.args);
        } catch {
          await ctx.reply(texts.unknownModel(ctx.args, deps.registry.listAliases()));
          return;
        }
        await deps.sessions.setModelAlias(session, ctx.args);
        await ctx.reply(texts.modelSwitched(ctx.args));
      },
    },
    {
      name: 'compact',
      visible: true,
      description: '把当前会话历史压缩成一段摘要（以你的需求为主线），上下文继续',
      usage: '/compact',
      async handler(ctx, deps) {
        const session = await deps.sessions.get(ctx.msg.platform, ctx.msg.chatId);
        if (session.history.length === 0) {
          await ctx.reply('当前会话还没有对话记录，没什么可压缩的。');
          return;
        }
        const before = session.history.length;
        const transcript = session.history
          .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)
          .join('\n');
        const prompt = [
          '请把下面这段人与助手的对话压缩成一段摘要，作为后续对话的背景。',
          '要求：',
          '- 以用户说过的话为主线：他们的需求、想法、提到的事实与偏好，尽量保留关键细节',
          '- 助手的回复只保留必要的结论，寒暄与过程性内容舍弃',
          '- 「名字：」开头的行来自群聊，摘要中保留说话人身份',
          '- 输出一段简洁叙述（不分点、不加标题），300 字以内',
          '',
          '对话记录：',
          transcript,
        ].join('\n');
        await ctx.reply('正在压缩对话…');
        let summary: string;
        try {
          summary = await deps.registry.chat(session.modelAlias, [
            { role: 'user', content: prompt },
          ]);
        } catch (err) {
          await ctx.reply(
            `压缩失败（${err instanceof Error ? err.message : '未知错误'}），原对话历史未受影响。`,
          );
          return;
        }
        const summaryMsg = {
          role: 'user' as const,
          content: `[以下是此前对话的压缩摘要，作为背景继续聊天]\n${summary.trim()}`,
        };
        await deps.sessions.replaceHistory(session, [summaryMsg]);
        await ctx.reply(
          `已压缩：${before} 条记录 → ${summary.trim().length} 字摘要，接下来以摘要为背景继续聊。`,
        );
      },
    },
    {
      name: 'reset',
      visible: true,
      description: '清空当前会话的对话历史',
      usage: '/reset',
      async handler(ctx, deps) {
        await deps.sessions.reset(ctx.msg.platform, ctx.msg.chatId);
        await ctx.reply(texts.reset);
      },
    },
    {
      name: 'remember',
      visible: true,
      description: '让我记住一件事（如 /remember 我对花生过敏）',
      usage: '/remember <内容>',
      async handler(ctx, deps) {
        if (!deps.memory) {
          await ctx.reply('记忆功能未开启（config.yaml 里 memory.enabled）。');
          return;
        }
        const fact = ctx.args.trim();
        if (!fact) {
          await ctx.reply('想让我记什么？例如：/remember 我对花生过敏');
          return;
        }
        const key = memoryKeyOf(ctx.msg.platform, ctx.msg.senderId);
        const existing = await deps.memory.load(key);
        await deps.memory.save(key, existing ? `${existing}\n- ${fact}` : `- ${fact}`);
        await ctx.reply(`记住了：${fact}`);
      },
    },
    {
      name: 'memory',
      visible: true,
      description: '查看我记住了关于你的什么',
      usage: '/memory',
      async handler(ctx, deps) {
        if (!deps.memory) {
          await ctx.reply('记忆功能未开启（config.yaml 里 memory.enabled）。');
          return;
        }
        const key = memoryKeyOf(ctx.msg.platform, ctx.msg.senderId);
        const known = (await deps.memory.load(key)) || '还没有关于你的记忆，聊着聊着就有了。';
        await ctx.reply(known);
      },
    },
    {
      name: 'forget',
      visible: true,
      description: '清空我记住的关于你的一切',
      usage: '/forget',
      async handler(ctx, deps) {
        if (!deps.memory) {
          await ctx.reply('记忆功能未开启（config.yaml 里 memory.enabled）。');
          return;
        }
        const key = memoryKeyOf(ctx.msg.platform, ctx.msg.senderId);
        await deps.memory.clear(key);
        await ctx.reply('已清空关于你的记忆。我们重新认识一下吧。');
      },
    },
    {
      name: 'remind',
      visible: true,
      description: '到点提醒你做某事（如 /remind 09:00 起床）',
      usage: '/remind <HH:MM 或 YYYY-MM-DD HH:MM> <内容>',
      async handler(ctx, deps) {
        if (!deps.reminders) {
          await ctx.reply('提醒功能未装配。');
          return;
        }
        const m = /^(\S+)\s+([\s\S]+)$/.exec(ctx.args.trim());
        if (!m) {
          await ctx.reply(
            '想提醒你什么？格式：/remind <时间> <内容>\n时间支持 HH:MM（今天，已过则明天）或 2026-11-10 09:00。',
          );
          return;
        }
        const parsed = parseRemindTime(m[1] ?? '');
        if (!parsed) {
          await ctx.reply(`时间「${m[1]}」看不懂。用 HH:MM 或 YYYY-MM-DD HH:MM 再试一次？`);
          return;
        }
        try {
          const r = deps.reminders.add({
            platform: ctx.msg.platform,
            chatId: ctx.msg.chatId,
            senderName: ctx.msg.senderName || '用户',
            text: (m[2] ?? '').trim(),
            dueAt: parsed.dueAt,
          });
          await ctx.reply(`好，已记下（id: ${r.id}）：${parsed.display} 提醒你「${r.text}」。`);
        } catch (err) {
          await ctx.reply(`没设成：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      name: 'reminders',
      visible: true,
      description: '列出本会话的定时提醒',
      usage: '/reminders',
      async handler(ctx, deps) {
        if (!deps.reminders) {
          await ctx.reply('提醒功能未装配。');
          return;
        }
        const list = deps.reminders.listByChat(ctx.msg.chatId);
        if (list.length === 0) {
          await ctx.reply('这个会话还没有待触发的提醒。');
          return;
        }
        const lines = list.map(
          (r) => `${r.id} · ${formatDisplay(new Date(r.dueAt))} · ${r.text}`,
        );
        await ctx.reply(`待触发的提醒：\n${lines.join('\n')}\n用 /unremind <id> 取消。`);
      },
    },
    {
      name: 'unremind',
      visible: true,
      description: '取消一个定时提醒',
      usage: '/unremind <id>',
      async handler(ctx, deps) {
        if (!deps.reminders) {
          await ctx.reply('提醒功能未装配。');
          return;
        }
        const id = ctx.args.trim();
        if (!id) {
          await ctx.reply('要取消哪个？/reminders 看列表，然后 /unremind <id>。');
          return;
        }
        await ctx.reply(
          deps.reminders.cancel(id, ctx.msg.chatId) ? `已取消提醒 ${id}。` : `没找到提醒 ${id}（/reminders 看看列表）。`,
        );
      },
    },
  ];
}
