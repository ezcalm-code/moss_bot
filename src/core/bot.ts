import type { IncomingMessage } from '../adapters/types';
import type { Logger } from '../log';
import type { LlmRegistry } from '../llm/registry';
import { texts } from '../text';
import { builtinCommands, CommandRegistry, parseCommand, type CommandDeps } from './commands';
import type { SessionManager } from './session';

export interface BotCoreOptions {
  registry: LlmRegistry;
  sessions: SessionManager;
  systemPrompt: string;
  personaName: string;
  log: Logger;
}

/** 平台无关的消息管道：命令路由 → 群聊过滤 → 会话装载 → LLM 流式回复 → 历史回写 */
export class BotCore {
  readonly commands: CommandRegistry;
  private readonly deps: CommandDeps;
  private readonly log: Logger;
  private readonly systemPrompt: string;

  constructor(opts: BotCoreOptions) {
    this.log = opts.log;
    this.systemPrompt = opts.systemPrompt;
    this.deps = {
      registry: opts.registry,
      sessions: opts.sessions,
      personaName: opts.personaName,
      commands: null as unknown as CommandRegistry,
    };
    this.commands = new CommandRegistry(builtinCommands());
    this.deps.commands = this.commands;
  }

  async handle(msg: IncomingMessage): Promise<void> {
    try {
      if (!msg.isTargeted) return;
      const text = msg.text.trim();
      if (!text) {
        if (msg.attachments.length > 0) {
          await msg.reply(texts.unsupportedAttachment);
        }
        return;
      }
      const parsed = parseCommand(text);
      if (parsed) {
        const spec = this.commands.lookup(parsed.name);
        if (!spec) {
          await msg.reply(texts.unknownCommand(parsed.name));
          return;
        }
        await spec.handler({ msg, args: parsed.args, reply: (t) => msg.reply(t) }, this.deps);
        return;
      }
      await this.chat(msg, text);
    } catch (err) {
      this.log.error({ err, platform: msg.platform, chatId: msg.chatId }, '处理消息失败');
      try {
        await msg.reply(texts.internalError);
      } catch {
        // 二次失败无法也无需再处理
      }
    }
  }

  private async chat(msg: IncomingMessage, text: string): Promise<void> {
    const { registry, sessions } = this.deps;
    const session = await sessions.get(msg.platform, msg.chatId);
    // 群聊共享一份历史，拼上说话人名字区分角色
    const userMsg = {
      role: 'user' as const,
      content: msg.isGroup ? `${msg.senderName}: ${text}` : text,
    };
    const messages = [
      { role: 'system' as const, content: this.systemPrompt },
      ...session.history,
      userMsg,
    ];
    const { entry, stream } = registry.streamChat(session.modelAlias, messages);
    const handle = await msg.startStreamReply();
    let full = '';
    try {
      for await (const delta of stream) {
        full += delta;
        await handle.append(delta);
      }
      await handle.finish();
    } catch (err) {
      this.log.warn({ err, model: entry.model, platform: msg.platform }, 'LLM 流式回复失败');
      await handle.abort(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    await sessions.appendTurn(session, userMsg, { role: 'assistant', content: full });
  }
}
