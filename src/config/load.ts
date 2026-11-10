import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_SYSTEM_PROMPT, configSchema, type ResolvedConfig } from './schema';
import { isValidTimezone } from '../time';

export class ConfigError extends Error {}

export function loadEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}

function readYamlConfig(path: string): unknown {
  if (!existsSync(path)) {
    throw new ConfigError(`配置文件不存在: ${path}（可复制 config.example.yaml 作为起点）`);
  }
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    const detail =
      err instanceof Error ? err.message.split('\n').slice(0, 5).join('\n') : String(err);
    throw new ConfigError(`配置文件解析失败 ${path}:\n${detail}`);
  }
}

function formatZodError(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((i) => `  - ${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

export function resolveConfig(
  raw: unknown,
  options: { configPath: string; env: NodeJS.ProcessEnv },
): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`配置校验失败:\n${formatZodError(parsed.error)}`);
  }
  const cfg = parsed.data;
  const configDir = dirname(resolve(options.configPath));

  if (cfg.persona.systemPrompt !== undefined && cfg.persona.systemPromptFile !== undefined) {
    throw new ConfigError('persona.systemPrompt 与 persona.systemPromptFile 只能配置其一');
  }
  let systemPrompt: string;
  if (cfg.persona.systemPromptFile !== undefined) {
    const p = isAbsolute(cfg.persona.systemPromptFile)
      ? cfg.persona.systemPromptFile
      : join(configDir, cfg.persona.systemPromptFile);
    if (!existsSync(p)) {
      throw new ConfigError(`persona.systemPromptFile 指向的文件不存在: ${p}`);
    }
    systemPrompt = readFileSync(p, 'utf8');
  } else if (cfg.persona.systemPrompt !== undefined) {
    systemPrompt = cfg.persona.systemPrompt;
  } else {
    systemPrompt = BUILTIN_SYSTEM_PROMPT;
  }

  const aliases = cfg.models.entries.map((e) => e.alias);
  if (cfg.timezone !== undefined && !isValidTimezone(cfg.timezone)) {
    throw new ConfigError(`timezone "${cfg.timezone}" 不是合法的 IANA 时区名（如 Asia/Shanghai）`);
  }
  const imageKey = options.env[cfg.imageGeneration.apiKeyEnv];
  if (cfg.imageGeneration.enabled && !imageKey) {
    throw new ConfigError(
      `imageGeneration.enabled=true 但环境变量 ${cfg.imageGeneration.apiKeyEnv} 为空`,
    );
  }
  const duplicate = aliases.find((a, i) => aliases.indexOf(a) !== i);
  if (duplicate !== undefined) {
    throw new ConfigError(`models.entries 存在重复 alias: ${duplicate}`);
  }
  const defaultAlias = cfg.models.default ?? (aliases[0] as string);
  if (!aliases.includes(defaultAlias)) {
    throw new ConfigError(`models.default "${defaultAlias}" 不在 models.entries 的 alias 列表中`);
  }
  for (const entry of cfg.models.entries) {
    if (!(entry.provider in cfg.providers)) {
      throw new ConfigError(`模型 "${entry.alias}" 引用了不存在的 provider: "${entry.provider}"`);
    }
  }

  const providers: ResolvedConfig['providers'] = {};
  for (const [id, p] of Object.entries(cfg.providers)) {
    let apiKey: string | undefined;
    if (p.apiKey !== undefined) {
      apiKey = p.apiKey;
    } else if (p.apiKeyEnv !== undefined) {
      apiKey = options.env[p.apiKeyEnv];
    }
    providers[id] = { baseUrl: p.baseUrl, apiKey, apiKeyEnv: p.apiKeyEnv };
  }

  const ws = cfg.tools.webSearch;
  const wsProviders: ResolvedConfig['tools']['webSearch']['providers'] = {};
  for (const [id, p] of Object.entries(ws.providers)) {
    wsProviders[id] = { apiKeyEnv: p.apiKeyEnv, apiKey: options.env[p.apiKeyEnv], baseUrl: p.baseUrl };
  }
  if (ws.enabled) {
    const selected = wsProviders[ws.provider];
    if (!selected) {
      throw new ConfigError(
        `tools.webSearch.provider "${ws.provider}" 未在 tools.webSearch.providers 中定义（已定义: ${Object.keys(wsProviders).join(', ') || '无'}）`,
      );
    }
    if (!selected.apiKey) {
      throw new ConfigError(`tools.webSearch 已启用但缺少 API key：请设置环境变量 ${selected.apiKeyEnv}`);
    }
  }

  const botToken = options.env[cfg.telegram.botTokenEnv];
  if (cfg.telegram.enabled && !botToken) {
    throw new ConfigError(`telegram.enabled=true 但环境变量 ${cfg.telegram.botTokenEnv} 为空`);
  }
  const appId = options.env[cfg.feishu.appIdEnv];
  const appSecret = options.env[cfg.feishu.appSecretEnv];
  if (cfg.feishu.enabled && (!appId || !appSecret)) {
    throw new ConfigError(
      `feishu.enabled=true 但环境变量 ${cfg.feishu.appIdEnv} / ${cfg.feishu.appSecretEnv} 为空`,
    );
  }

  return {
    log: cfg.log,
    persona: { name: cfg.persona.name, systemPrompt },
    models: { defaultAlias, entries: cfg.models.entries },
    providers,
    session: cfg.session,
    telegram: { enabled: cfg.telegram.enabled, botToken },
    feishu: {
      enabled: cfg.feishu.enabled,
      appId,
      appSecret,
      domain: cfg.feishu.domain,
      streaming: cfg.feishu.streaming,
    },
    memory: cfg.memory,
    timezone: cfg.timezone,
    imageGeneration: {
      enabled: cfg.imageGeneration.enabled,
      provider: cfg.imageGeneration.provider,
      apiKeyEnv: cfg.imageGeneration.apiKeyEnv,
      apiKey: imageKey,
      cooldownMinutes: cfg.imageGeneration.cooldownMinutes,
    },
    tools: {
      webSearch: {
        enabled: ws.enabled,
        provider: ws.provider,
        maxResults: ws.maxResults,
        cooldownMinutes: ws.cooldownMinutes,
        providers: wsProviders,
      },
    },
  };
}

export function loadConfig(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedConfig {
  const env = options.env ?? process.env;
  const path = options.path ?? env.MOSS_CONFIG ?? 'config.yaml';
  return resolveConfig(readYamlConfig(path), { configPath: path, env });
}
