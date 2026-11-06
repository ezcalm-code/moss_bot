import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BUILTIN_SYSTEM_PROMPT, configSchema, type ResolvedConfig } from './schema';

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
  };
}

export function loadConfig(
  options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedConfig {
  const env = options.env ?? process.env;
  const path = options.path ?? env.MOSS_CONFIG ?? 'config.yaml';
  return resolveConfig(readYamlConfig(path), { configPath: path, env });
}
