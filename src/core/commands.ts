import type { IncomingMessage } from '../adapters/types';
import type { LlmRegistry } from '../llm/registry';
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
      name: 'reset',
      visible: true,
      description: '清空当前会话的对话历史',
      usage: '/reset',
      async handler(ctx, deps) {
        await deps.sessions.reset(ctx.msg.platform, ctx.msg.chatId);
        await ctx.reply(texts.reset);
      },
    },
  ];
}
