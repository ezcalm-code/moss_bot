import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';

/** 传给工具的运行时上下文（按次调用构造，无共享可变状态） */
export interface ToolContext {
  readonly platform: PlatformId;
  readonly chatId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly isGroup: boolean;
  /** 单次用户消息一个 id：同一轮内多次工具调用可据此放行（如 web_search 同轮不冷却） */
  readonly turnId: string;
  readonly log: Logger;
  readonly signal?: AbortSignal;
}

/**
 * 工具定义：name/description/parameters 是给模型看的 wire 协议，exec 是执行体。
 * exec 返回值即 role=tool 的 content 原文——冷却、失败、参数错都返回说明字符串，
 * 让模型自己措辞转述给用户；不要 throw（ToolRunner 会兜底，但返回串可携带更精确的语境）。
 */
export interface ToolSpec {
  /** wire 名，snake_case（模型端约定俗成） */
  readonly name: string;
  /** 触发判断完全靠它：写清「何时该调 / 何时不该调」 */
  readonly description: string;
  /** JSON Schema（openai function.parameters 形状） */
  readonly parameters: Record<string, unknown>;
  exec(args: unknown, ctx: ToolContext): Promise<string>;
}

/** 网页正文提取器：read_url 工具的后端，可插拔（当前仅 Tavily Extract 实现） */
export interface PageExtractor {
  readonly id: string;
  /** 返回页面正文纯文本；失败 throw，由工具层转错误说明 */
  extract(url: string): Promise<string>;
}
