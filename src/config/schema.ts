import { z } from 'zod';

export const BUILTIN_SYSTEM_PROMPT =
  '你是 Moss，一个简洁、直接、有点幽默感的 AI 助手。不确定的事情明确说不知道。默认使用与用户相同的语言回复。';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const providerSchema = z.object({
  baseUrl: z.url(),
  apiKeyEnv: z.string().min(1).optional(),
  apiKey: z.string().optional(),
});

const webSearchProviderSchema = z.object({
  apiKeyEnv: z.string().min(1),
  baseUrl: z.url().optional(),
});

export const configSchema = z.object({
  log: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']) }).prefault({ level: 'info' }),
  persona: z
    .object({
      name: z.string().min(1),
      systemPrompt: z.string().optional(),
      systemPromptFile: z.string().optional(),
    })
    .prefault({ name: 'Moss' }),
  models: z.object({
    default: z.string().optional(),
    entries: z
      .array(
        z.object({
          alias: z.string().min(1),
          provider: z.string().min(1),
          model: z.string().min(1),
          supportsTools: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
  providers: z.record(z.string().min(1), providerSchema),
  session: z
    .object({
      store: z.enum(['memory', 'file']),
      maxHistoryMessages: z.number().int().min(2),
    })
    .prefault({ store: 'memory', maxHistoryMessages: 40 }),
  telegram: z
    .object({
      enabled: z.boolean(),
      botTokenEnv: z.string().min(1),
    })
    .prefault({ enabled: false, botTokenEnv: 'TELEGRAM_BOT_TOKEN' }),
  feishu: z
    .object({
      enabled: z.boolean(),
      appIdEnv: z.string().min(1),
      appSecretEnv: z.string().min(1),
      domain: z.enum(['feishu', 'lark']),
      streaming: z.boolean(),
    })
    .prefault({
      enabled: false,
      appIdEnv: 'FEISHU_APP_ID',
      appSecretEnv: 'FEISHU_APP_SECRET',
      domain: 'feishu',
      streaming: true,
    }),
  memory: z.object({ enabled: z.boolean() }).prefault({ enabled: true }),
  tools: z
    .object({
      webSearch: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.string().min(1).default('tavily'),
          maxResults: z.number().int().min(1).max(10).default(5),
          cooldownMinutes: z.number().min(0).default(5),
          providers: z.record(z.string().min(1), webSearchProviderSchema).default({}),
        })
        .prefault({
          enabled: false,
          provider: 'tavily',
          maxResults: 5,
          cooldownMinutes: 5,
          providers: {},
        }),
    })
    .prefault({
      webSearch: { enabled: false, provider: 'tavily', maxResults: 5, cooldownMinutes: 5, providers: {} },
    }),
});

export type YamlConfig = z.infer<typeof configSchema>;

export interface ModelEntry {
  alias: string;
  provider: string;
  model: string;
  /** 缺省视为支持工具调用；false = 不挂工具（网关不透传 / 模型不支持） */
  supportsTools?: boolean;
}

export interface ResolvedConfig {
  log: { level: LogLevel };
  persona: { name: string; systemPrompt: string };
  models: { defaultAlias: string; entries: ModelEntry[] };
  providers: Record<
    string,
    { baseUrl: string; apiKey: string | undefined; apiKeyEnv: string | undefined }
  >;
  session: { store: 'memory' | 'file'; maxHistoryMessages: number };
  telegram: { enabled: boolean; botToken: string | undefined };
  feishu: {
    enabled: boolean;
    appId: string | undefined;
    appSecret: string | undefined;
    domain: 'feishu' | 'lark';
    streaming: boolean;
  };
  memory: { enabled: boolean };
  tools: {
    webSearch: {
      enabled: boolean;
      provider: string;
      maxResults: number;
      cooldownMinutes: number;
      providers: Record<
        string,
        { apiKeyEnv: string; apiKey: string | undefined; baseUrl: string | undefined }
      >;
    };
  };
}
