import type { IncomingMessage } from '../adapters/types';
import type { Logger } from '../log';
import type { LlmRegistry } from '../llm/registry';
import type { MessageContent } from '../llm/types';
import { buildExtractPrompt, memoryKeyOf, type UserMemoryStore } from '../memory/store';
import { texts } from '../text';
import { builtinCommands, CommandRegistry, parseCommand, type CommandDeps } from './commands';
import type { SessionManager } from './session';

export interface BotCoreOptions {
  registry: LlmRegistry;
  sessions: SessionManager;
  systemPrompt: string;
  personaName: string;
  log: Logger;
  /** 跨会话用户记忆；缺省 = 记忆功能关闭 */
  memory?: UserMemoryStore;
}

/** 平台无关的消息管道：命令路由 → 群聊过滤 → 会话装载 → LLM 流式回复 → 历史回写 */
export class BotCore {
  readonly commands: CommandRegistry;
  private readonly deps: CommandDeps;
  private readonly log: Logger;
  private readonly systemPrompt: string;
  private readonly memory: UserMemoryStore | undefined;

  constructor(opts: BotCoreOptions) {
    this.log = opts.log;
    this.systemPrompt = opts.systemPrompt;
    this.memory = opts.memory;
    this.deps = {
      registry: opts.registry,
      sessions: opts.sessions,
      personaName: opts.personaName,
      memory: opts.memory,
      commands: null as unknown as CommandRegistry,
    };
    this.commands = new CommandRegistry(builtinCommands());
    this.deps.commands = this.commands;
  }

  async handle(msg: IncomingMessage): Promise<void> {
    try {
      if (!msg.isTargeted) return;
      const text = msg.text.trim();
      const hasImage = msg.attachments.some((a) => a.type === 'image');
      const hasOtherAttachments = msg.attachments.length > (hasImage ? 1 : 0);

      if (!text && !hasImage) {
        if (msg.attachments.length > 0) {
          await msg.reply(texts.unsupportedAttachment);
        }
        return;
      }
      if (hasOtherAttachments) {
        await msg.reply(texts.unsupportedAttachment);
        return;
      }
      if (text) {
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
      }
      await this.chat(msg, text, hasImage);
    } catch (err) {
      this.log.error({ err, platform: msg.platform, chatId: msg.chatId }, '处理消息失败');
      try {
        await msg.reply(texts.internalError);
      } catch {
        // 二次失败无法也无需再处理
      }
    }
  }

  private async chat(msg: IncomingMessage, text: string, hasImage: boolean): Promise<void> {
    const { registry, sessions } = this.deps;
    const session = await sessions.get(msg.platform, msg.chatId);

    let dataUrls: string[] = [];
    if (hasImage) {
      dataUrls = await msg.getAttachmentDataUrls();
      const model = registry.entryFor(session.modelAlias).model;
      if (registry.isVisionBlocked(model)) {
        await msg.reply(texts.noVision(registry.listAliases()));
        return;
      }
    }

    // 群聊共享一份历史，拼上说话人名字区分角色
    const prefixedText = msg.isGroup ? `${msg.senderName}: ${text}` : text;
    const requestContent: MessageContent = dataUrls.length
      ? [
          { type: 'text', text: prefixedText || '（用户发送了一张图片）' },
          ...dataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ]
      : prefixedText;
    // 图片 base64 不进历史（体积原因）：历史里只留占位，仅当前请求带图
    const historyContent =
      dataUrls.length > 0 ? (text ? `[图片] ${text}` : '[图片]') : prefixedText;
    const userMsg = { role: 'user' as const, content: historyContent };
    const messages = [
      { role: 'system' as const, content: await this.systemWithMemory(msg) },
      ...session.history,
      { role: 'user' as const, content: requestContent },
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
      // 带图请求被 API 拒绝（4xx）：运行时探测为该模型不支持视觉，记入缓存并引导用户换模型
      if (dataUrls.length > 0 && isClientApiRejection(err)) {
        registry.markNoVision(entry.model);
        await handle.abort(new Error(texts.noVision(registry.listAliases())));
        return;
      }
      await handle.abort(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    await sessions.appendTurn(session, userMsg, { role: 'assistant', content: full });
    // 记忆提取在回复完成后后台进行，不阻塞、失败静默
    void this.extractMemory(msg, text, full, session.modelAlias);
  }

  private async systemWithMemory(msg: IncomingMessage): Promise<string> {
    if (!this.memory) return this.systemPrompt;
    try {
      const known = await this.memory.load(memoryKeyOf(msg.platform, msg.senderId));
      if (!known) return this.systemPrompt;
      return `${this.systemPrompt}\n\n## 关于这位用户的已知信息（描述的就是当前对话的用户本人，昵称可能来自群聊；可能过时，谨慎参考）\n${known}`;
    } catch {
      return this.systemPrompt;
    }
  }

  private async extractMemory(
    msg: IncomingMessage,
    userText: string,
    replyText: string,
    modelAlias?: string,
  ): Promise<void> {
    if (!this.memory) return;
    try {
      const key = memoryKeyOf(msg.platform, msg.senderId);
      const existing = await this.memory.load(key);
      const transcript = msg.isGroup
        ? `${msg.senderName}: ${userText}`
        : `用户：${userText}\n助手：${replyText}`;
      const prompt = buildExtractPrompt(existing, transcript);
      const next = (
        await this.deps.registry.chat(modelAlias, [{ role: 'user', content: prompt }])
      ).trim();
      if (!next || next === existing) return;
      await this.memory.save(key, next);
    } catch (err) {
      this.log.warn({ err, platform: msg.platform }, '记忆提取失败（不影响对话）');
    }
  }
}

/** openai SDK 的 APIError 带 status；4xx 视为请求被服务端拒绝（5xx 是服务端自身问题，不据此判定） */
function isClientApiRejection(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}
