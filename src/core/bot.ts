import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '../adapters/types';
import type { Logger } from '../log';
import type { LlmRegistry } from '../llm/registry';
import type { ChatMessage, MessageContent, ToolCall } from '../llm/types';
import { buildExtractPrompt, memoryKeyOf, type UserMemoryStore } from '../memory/store';
import type { BroadcastService } from '../broadcasts/service';
import type { NotesService } from '../notes/service';
import type { PollsService } from '../polls/service';
import type { ReminderService } from '../reminders/service';
import { zonedNow } from '../time';
import { toFunctionTool, type ToolRunner } from '../tools';
import { texts } from '../text';
import { builtinCommands, CommandRegistry, parseCommand, type CommandDeps } from './commands';
import type { SessionManager } from './session';

/** 单次用户消息内允许的最多工具执行轮数；第 6 次请求起不带 tools 强制纯文本作答 */
const MAX_TOOL_ROUNDS = 5;

/** 同会话排队上限：达到后丢弃新消息（群聊刷屏防护）；私聊正常使用到不了 */
const MAX_PENDING_PER_CHAT = 5;

export interface BotCoreOptions {
  registry: LlmRegistry;
  sessions: SessionManager;
  systemPrompt: string;
  personaName: string;
  log: Logger;
  /** 跨会话用户记忆；缺省 = 记忆功能关闭 */
  memory?: UserMemoryStore;
  /** 工具执行器；缺省 = 无工具（请求不带 tools） */
  tools?: ToolRunner;
  /** 定时提醒服务；缺省 = 提醒命令不可用 */
  reminders?: ReminderService;
  /** 加密笔记服务；缺省 = 笔记命令不可用（未配置 NOTES_ENCRYPTION_KEY） */
  notes?: NotesService;
  /** 每日播报服务；缺省 = 播报命令不可用（未启用联网搜索） */
  broadcasts?: BroadcastService;
  /** 群投票服务；缺省 = 投票命令不可用 */
  polls?: PollsService;
  /** IANA 时区；缺省 = 进程本地。时间注入与提醒解析统一锚定 */
  timezone?: string;
}

/** 平台无关的消息管道：命令路由 → 群聊过滤 → 会话装载 → LLM 流式回复 → 历史回写 */
export class BotCore {
  readonly commands: CommandRegistry;
  private readonly deps: CommandDeps;
  private readonly log: Logger;
  private readonly systemPrompt: string;
  private readonly memory: UserMemoryStore | undefined;
  private readonly tools: ToolRunner | undefined;
  private readonly timezone: string | undefined;
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly queueDepth = new Map<string, number>();

  constructor(opts: BotCoreOptions) {
    this.log = opts.log;
    this.systemPrompt = opts.systemPrompt;
    this.memory = opts.memory;
    this.tools = opts.tools;
    this.timezone = opts.timezone;
    this.deps = {
      registry: opts.registry,
      sessions: opts.sessions,
      personaName: opts.personaName,
      memory: opts.memory,
      reminders: opts.reminders,
      notes: opts.notes,
      broadcasts: opts.broadcasts,
      polls: opts.polls,
      timezone: opts.timezone,
      commands: null as unknown as CommandRegistry,
    };
    this.commands = new CommandRegistry(builtinCommands());
    this.deps.commands = this.commands;
  }

  /** 同会话串行化：飞书事件是异步派发会并发进入，群聊共享历史与流式回复都依赖顺序 */
  async handle(msg: IncomingMessage): Promise<void> {
    const key = `${msg.platform}:${msg.chatId}`;
    const depth = this.queueDepth.get(key) ?? 0;
    if (depth >= MAX_PENDING_PER_CHAT) {
      this.log.info({ platform: msg.platform, chatId: msg.chatId }, '会话排队已满，丢弃新消息');
      return;
    }
    this.queueDepth.set(key, depth + 1);
    const prev = this.chatQueues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.process(msg));
    this.chatQueues.set(key, next);
    void next.finally(() => {
      const remaining = (this.queueDepth.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.queueDepth.delete(key);
        if (this.chatQueues.get(key) === next) this.chatQueues.delete(key);
      } else {
        this.queueDepth.set(key, remaining);
      }
    });
    return next;
  }

  private async process(msg: IncomingMessage): Promise<void> {
    try {
      if (!msg.isTargeted) {
        // 群聊里发图无法 @bot（图片消息本身不带文字与 @），这是最常见的静默丢弃点，留痕便于排查
        if (msg.attachments.some((a) => a.type === 'image')) {
          this.log.info(
            { platform: msg.platform, chatId: msg.chatId, senderId: msg.senderId },
            '群聊图片消息未 @bot，已忽略（如需识别请在群里回复该图并 @bot）',
          );
        }
        return;
      }
      const text = msg.text.trim();
      const hasImage = msg.attachments.some((a) => a.type === 'image');
      const hasOtherAttachments = msg.attachments.length > (hasImage ? 1 : 0);

      if (!text && !hasImage) {
        if (msg.attachments.length > 0) {
          await msg.reply(texts.unsupportedAttachment);
        } else if (msg.isTargeted) {
          // 被 @ / 回复但剥掉 @ 后没内容：回轻量搭话而不是装死（用户会以为 bot 挂了）
          await msg.reply(texts.emptyMention);
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
    const entry = registry.entryFor(session.modelAlias);
    const turnId = randomUUID();

    // 无条件探测图片：本条带图、或回复了图片消息（图在被回复消息里）都由此取到；
    // 无图时实现返回空数组，代价极小
    const dataUrls = await msg.getAttachmentDataUrls();
    if (dataUrls.length > 0 && registry.isVisionBlocked(entry.model)) {
      await msg.reply(texts.noVision(registry.listAliases()));
      return;
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

    // 带图轮也挂工具：「发图让 bot 模仿生图」需要同轮看图 + 画图。
    // 4xx 归因（图 vs 工具被拒）改为降级顺序解决：首轮被拒先去工具重试（图保留），仍拒才判视觉问题——见 catch。
    const toolDefs =
      this.tools && !registry.isToolsBlocked(entry.model)
        ? this.tools.specs().map(toFunctionTool)
        : undefined;

    const handle = await msg.startStreamReply();
    let full = '';
    let toolRound = 0;
    let pending = messages;
    const consumeRound = async (tools: typeof toolDefs) => {
      const { stream } = registry.streamChat(session.modelAlias, pending, { tools });
      let finish = 'stop';
      const calls: ToolCall[] = [];
      let roundText = '';
      for await (const evt of stream) {
        if (evt.type === 'text') {
          full += evt.text;
          roundText += evt.text;
          await handle.append(evt.text);
        } else if (evt.type === 'tool_call') {
          calls.push(evt.call);
        } else {
          finish = evt.reason;
        }
      }
      return { finish, calls, roundText };
    };
    try {
      for (;;) {
        const { finish, calls, roundText } = await consumeRound(
          toolRound < MAX_TOOL_ROUNDS ? toolDefs : undefined,
        );
        if (finish !== 'tool_calls' || calls.length === 0) break;
        const toolMsgs = await this.execToolCalls(calls, msg, turnId);
        pending = [...pending, { role: 'assistant', content: roundText, tool_calls: calls }, ...toolMsgs];
        toolRound++;
      }
      await handle.finish();
    } catch (err) {
      this.log.warn({ err, model: entry.model, platform: msg.platform }, 'LLM 流式回复失败');
      // 首轮带工具被 4xx 拒：透明降级——去工具重试一次（带图轮保留图，看图不受影响）。
      // 带图轮的 4xx 无法区分图/工具归因：不标能力位，等重试结果——重试仍 4xx 才判视觉问题。
      let finalErr: unknown = err;
      if (toolDefs && toolRound === 0 && full === '' && isClientApiRejection(err)) {
        if (dataUrls.length === 0) {
          registry.markNoTools(entry.model);
          this.log.info({ model: entry.model }, '模型不支持工具调用，已标记并以无工具重试');
        } else {
          this.log.info({ model: entry.model }, '带图轮 4xx，先去工具重试以归因');
        }
        try {
          await consumeRound(undefined);
          await handle.finish();
          await sessions.appendTurn(session, userMsg, { role: 'assistant', content: full });
          void this.extractMemory(msg, text, full, session.modelAlias);
          return;
        } catch (retryErr) {
          finalErr = retryErr;
        }
      }
      // 无工具请求仍被 4xx 拒且带图：判定为视觉问题，标记并引导换模型
      if (dataUrls.length > 0 && isClientApiRejection(finalErr)) {
        registry.markNoVision(entry.model);
        await handle.abort(new Error(texts.noVision(registry.listAliases())));
        return;
      }
      await handle.abort(finalErr instanceof Error ? finalErr : new Error(String(finalErr)));
      return;
    }
    await sessions.appendTurn(session, userMsg, { role: 'assistant', content: full });
    // 记忆提取在回复完成后后台进行，不阻塞、失败静默
    void this.extractMemory(msg, text, full, session.modelAlias);
  }

  /** 执行一轮全部工具调用并组装 role=tool 回传消息 */
  private async execToolCalls(
    calls: readonly ToolCall[],
    msg: IncomingMessage,
    turnId: string,
  ): Promise<ChatMessage[]> {
    if (!this.tools) return [];
    const out: ChatMessage[] = [];
    for (const call of calls) {
      const result = await this.tools.exec(call.name, call.arguments, {
        platform: msg.platform,
        chatId: msg.chatId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        isGroup: msg.isGroup,
        turnId,
        log: this.log,
      });
      out.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    return out;
  }

  private async systemWithMemory(msg: IncomingMessage): Promise<string> {
    const base = `${this.systemPrompt}\n\n${currentDateLine(this.timezone)}`;
    if (!this.memory) return base;
    try {
      const known = await this.memory.load(memoryKeyOf(msg.platform, msg.senderId));
      if (!known) return base;
      return `${base}\n\n## 关于这位用户的已知信息（描述的就是当前对话的用户本人，昵称可能来自群聊；可能过时，谨慎参考）\n${known}`;
    } catch {
      return base;
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

/** 模型无时间感知（训练截止 + 无时钟），「今天/最近/X分钟后」类问题与工具的时间推算都靠这行锚定 */
function currentDateLine(timezone?: string): string {
  const p = zonedNow(timezone);
  const week = '日一二三四五六'[p.weekday];
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  return `现在的本地时间是 ${date} ${clock}（周${week}）。用户说「今天/昨天/最近/X分钟后」时以此为准推算；信息无法确认时效时，明确说明日期与不确定性。`;
}
