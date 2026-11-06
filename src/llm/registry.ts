import { ConfigError } from '../config/load';
import type { ModelEntry, ResolvedConfig } from '../config/schema';
import { OpenAICompatProvider } from './openai-compat';
import type { ChatMessage, LLMProvider } from './types';
import type { Dispatcher } from 'undici';

export class LlmRegistry {
  /** 运行时探测：发图被 4xx 拒绝的模型记录在此，后续直接提示而非重试浪费调用 */
  private readonly noVisionModels = new Set<string>();

  constructor(
    private readonly providers: ReadonlyMap<string, LLMProvider>,
    private readonly missingKeyHints: ReadonlyMap<string, string>,
    public readonly entries: readonly ModelEntry[],
    public readonly defaultAlias: string,
  ) {}

  markNoVision(model: string): void {
    this.noVisionModels.add(model);
  }

  isVisionBlocked(model: string): boolean {
    return this.noVisionModels.has(model);
  }

  listAliases(): string[] {
    return this.entries.map((e) => e.alias);
  }

  entryFor(alias?: string): ModelEntry {
    const target = alias ?? this.defaultAlias;
    const entry = this.entries.find((e) => e.alias === target);
    if (!entry) {
      throw new ConfigError(
        `未知模型 alias: "${target}"（可用: ${this.listAliases().join(', ')}）`,
      );
    }
    return entry;
  }

  resolve(alias?: string): { entry: ModelEntry; provider: LLMProvider } {
    const entry = this.entryFor(alias);
    const provider = this.providers.get(entry.provider);
    if (!provider) {
      // 未实例化的 provider 一定是缺 key（配置交叉校验已保证其存在于 providers 段）
      throw new ConfigError(
        this.missingKeyHints.get(entry.provider) ?? `provider "${entry.provider}" 未装配`,
      );
    }
    return { entry, provider };
  }

  chat(
    alias: string | undefined,
    messages: readonly ChatMessage[],
    opts?: { signal?: AbortSignal },
  ) {
    const { entry, provider } = this.resolve(alias);
    return provider.chat(messages, { model: entry.model, signal: opts?.signal });
  }

  streamChat(
    alias: string | undefined,
    messages: readonly ChatMessage[],
    opts?: { signal?: AbortSignal },
  ): { entry: ModelEntry; stream: AsyncIterable<string> } {
    const { entry, provider } = this.resolve(alias);
    return {
      entry,
      stream: provider.streamChat(messages, { model: entry.model, signal: opts?.signal }),
    };
  }
}

export function buildRegistry(config: ResolvedConfig, proxyDispatcher?: Dispatcher): LlmRegistry {
  const providers = new Map<string, LLMProvider>();
  const missingKeyHints = new Map<string, string>();
  for (const [id, p] of Object.entries(config.providers)) {
    if (!p.apiKey) {
      // 缺 key 的 provider 不实例化，留到真正被使用时才报错，避免堵死其余模型的启动
      missingKeyHints.set(
        id,
        `provider "${id}" 缺少 API key：请设置环境变量 ${p.apiKeyEnv ?? '(未配置 apiKeyEnv)'}，或在配置中内联 providers.${id}.apiKey`,
      );
      continue;
    }
    providers.set(
      id,
      new OpenAICompatProvider({
        id,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        dispatcher: proxyDispatcher,
      }),
    );
  }
  return new LlmRegistry(
    providers,
    missingKeyHints,
    config.models.entries,
    config.models.defaultAlias,
  );
}

export type { ChatMessage, ChatOptions, LLMProvider } from './types';
