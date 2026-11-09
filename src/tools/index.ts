import { ConfigError } from '../config/load';
import type { ResolvedConfig } from '../config/schema';
import type { Dispatcher } from 'undici';
import type { FunctionToolDef } from '../llm/types';
import { createReadUrlTool } from './read-url';
import {
  createTavilyExtractor,
  createTavilyProvider,
  type SearchProvider,
} from './web-search/tavily';
import { createWebSearchTool } from './web-search';
import type { PageExtractor, ToolContext, ToolSpec } from './types';

export type { ToolContext, ToolSpec, PageExtractor } from './types';
export type { SearchProvider, SearchResult } from './web-search/tavily';

/** 单次工具结果总长上限（多结果拼接后兜底截断） */
const MAX_TOOL_RESULT_CHARS = 4000;

/** ToolSpec → openai function tools 的 wire 形状 */
export function toFunctionTool(spec: ToolSpec): FunctionToolDef {
  return {
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  };
}

/**
 * 运行时聚合：查表 + 参数解析 + 异常兜底，exec 永不 throw——
 * 未知工具 / 非法 JSON / 执行抛错 / 结果超长，一律返回错误说明字符串，工具循环不断。
 */
export class ToolRunner {
  private readonly byName = new Map<string, ToolSpec>();

  constructor(tools: readonly ToolSpec[]) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  /** 供 bot 拼请求 */
  specs(): readonly ToolSpec[] {
    return [...this.byName.values()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  async exec(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const spec = this.byName.get(name);
    if (!spec) return `未知工具 "${name}"（可用: ${[...this.byName.keys()].join(', ') || '无'}）`;
    let args: unknown;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return `工具 ${name} 的参数不是合法 JSON，原始参数: ${rawArgs.slice(0, 200)}。请修正后重试，或直接回答。`;
    }
    try {
      return await this.truncate(await spec.exec(args, ctx));
    } catch (err) {
      ctx.log.warn({ err, tool: name }, '工具执行抛错');
      return `工具 ${name} 执行失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private truncate(result: string): string {
    if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
    return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n（结果过长已截断）`;
  }
}

/** 已知搜索/抓取源实现注册表；SearXNG 等自托管源实现后在此登记 */
export const SEARCH_PROVIDER_FACTORIES: Record<
  string,
  (opts: { apiKey: string; baseUrl?: string; dispatcher?: Dispatcher }) => SearchProvider
> = {
  tavily: createTavilyProvider,
};

/** 装配点入口；enabled=false 或缺 tools 段返回 undefined（BotCore 视为无工具） */
export function createToolRunner(
  config: ResolvedConfig['tools'],
  proxyDispatcher?: Dispatcher,
): ToolRunner | undefined {
  const ws = config.webSearch;
  if (!ws.enabled) return undefined;
  const factory = SEARCH_PROVIDER_FACTORIES[ws.provider];
  if (!factory) {
    throw new ConfigError(
      `未知的 tools.webSearch.provider: "${ws.provider}"（当前支持: ${Object.keys(SEARCH_PROVIDER_FACTORIES).join(', ')}）`,
    );
  }
  const p = ws.providers[ws.provider];
  if (!p?.apiKey) {
    throw new ConfigError(
      `tools.webSearch 已启用但缺少 API key：请设置环境变量 ${p?.apiKeyEnv ?? '(未配置 apiKeyEnv)'}`,
    );
  }
  const common = { apiKey: p.apiKey, baseUrl: p.baseUrl, dispatcher: proxyDispatcher };
  const provider = factory(common);
  const extractor: PageExtractor = createTavilyExtractor(common);
  const spec = createWebSearchTool({
    provider,
    maxResults: ws.maxResults,
    cooldownMinutes: ws.cooldownMinutes,
  });
  const readUrl = createReadUrlTool({ extractor });
  return new ToolRunner([spec, readUrl]);
}
