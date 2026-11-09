import { describe, expect, it } from 'vitest';
import { resolveConfig } from './load';
import { configSchema } from './schema';

const base = {
  models: { entries: [{ alias: 'grok', provider: 'xai', model: 'grok-4-mini' }] },
  providers: { xai: { baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' } },
};

const opts = { configPath: 'config.yaml', env: {} as NodeJS.ProcessEnv };

describe('configSchema', () => {
  it('最小配置应用全部默认值', () => {
    const parsed = configSchema.parse(base);
    expect(parsed.log.level).toBe('info');
    expect(parsed.persona.name).toBe('Moss');
    expect(parsed.session.store).toBe('memory');
    expect(parsed.session.maxHistoryMessages).toBe(40);
    expect(parsed.telegram.enabled).toBe(false);
    expect(parsed.telegram.botTokenEnv).toBe('TELEGRAM_BOT_TOKEN');
    expect(parsed.feishu.enabled).toBe(false);
    expect(parsed.feishu.streaming).toBe(true);
  });

  it('非法 log.level 报错且含字段路径', () => {
    const r = configSchema.safeParse({ ...base, log: { level: 'loud' } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.map(String).join('.') === 'log.level')).toBe(true);
    }
  });

  it('空 entries 拒绝', () => {
    const r = configSchema.safeParse({ ...base, models: { entries: [] } });
    expect(r.success).toBe(false);
  });
});

describe('resolveConfig 交叉校验', () => {
  it('default alias 不在 entries 中时报错', () => {
    expect(() =>
      resolveConfig({ ...base, models: { default: 'nope', entries: base.models.entries } }, opts),
    ).toThrow(/models\.default/);
  });

  it('entry 引用未知 provider 时报错', () => {
    expect(() =>
      resolveConfig(
        {
          models: { entries: [{ alias: 'a', provider: 'ghost', model: 'm' }] },
          providers: base.providers,
        },
        opts,
      ),
    ).toThrow(/ghost/);
  });

  it('重复 alias 报错', () => {
    expect(() =>
      resolveConfig(
        {
          models: {
            entries: [
              { alias: 'grok', provider: 'xai', model: 'a' },
              { alias: 'grok', provider: 'xai', model: 'b' },
            ],
          },
          providers: base.providers,
        },
        opts,
      ),
    ).toThrow(/重复 alias/);
  });

  it('persona 同时配置 systemPrompt 与 systemPromptFile 报错', () => {
    expect(() =>
      resolveConfig(
        { ...base, persona: { name: 'Moss', systemPrompt: 'x', systemPromptFile: 'y.md' } },
        opts,
      ),
    ).toThrow(/只能配置其一/);
  });

  it('systemPromptFile 不存在时报错', () => {
    expect(() =>
      resolveConfig(
        { ...base, persona: { name: 'Moss', systemPromptFile: './no-such-file.md' } },
        opts,
      ),
    ).toThrow(/不存在/);
  });

  it('apiKeyEnv 解析为环境变量值；未设置时为 undefined', () => {
    const withKey = resolveConfig(base, {
      configPath: 'config.yaml',
      env: { XAI_API_KEY: 'sk-test' },
    });
    expect(withKey.providers.xai?.apiKey).toBe('sk-test');
    const noKey = resolveConfig(base, opts);
    expect(noKey.providers.xai?.apiKey).toBeUndefined();
  });

  it('默认 alias 取 entries[0]', () => {
    const cfg = resolveConfig(base, opts);
    expect(cfg.models.defaultAlias).toBe('grok');
  });

  it('telegram.enabled=true 且 token 缺失时报错并指明环境变量名', () => {
    expect(() =>
      resolveConfig({ ...base, telegram: { enabled: true, botTokenEnv: 'MY_TOKEN' } }, opts),
    ).toThrow(/MY_TOKEN/);
  });

  it('telegram.enabled=true 且 token 存在时通过', () => {
    const cfg = resolveConfig(
      { ...base, telegram: { enabled: true, botTokenEnv: 'MY_TOKEN' } },
      { configPath: 'config.yaml', env: { MY_TOKEN: '123:abc' } },
    );
    expect(cfg.telegram.botToken).toBe('123:abc');
  });

  it('feishu.enabled=true 且凭据缺失时报错', () => {
    expect(() =>
      resolveConfig(
        {
          ...base,
          feishu: {
            enabled: true,
            appIdEnv: 'F_ID',
            appSecretEnv: 'F_SECRET',
            domain: 'feishu' as const,
            streaming: true,
          },
        },
        { configPath: 'config.yaml', env: { F_ID: 'cli_x' } },
      ),
    ).toThrow(/F_SECRET/);
  });
});

describe('tools 段', () => {
  it('无 tools 段时 webSearch 全默认且关闭', () => {
    const cfg = resolveConfig(base, opts);
    expect(cfg.tools.webSearch.enabled).toBe(false);
    expect(cfg.tools.webSearch.provider).toBe('tavily');
    expect(cfg.tools.webSearch.maxResults).toBe(5);
    expect(cfg.tools.webSearch.cooldownMinutes).toBe(5);
    expect(cfg.tools.webSearch.providers).toEqual({});
  });

  it('只写 enabled 与 provider 定义时其余字段填默认，env key 解析', () => {
    const cfg = resolveConfig(
      {
        ...base,
        tools: {
          webSearch: {
            enabled: true,
            provider: 'tavily',
            providers: { tavily: { apiKeyEnv: 'TAVILY_API_KEY' } },
          },
        },
      },
      { configPath: 'config.yaml', env: { TAVILY_API_KEY: 'tvly-1' } },
    );
    expect(cfg.tools.webSearch.enabled).toBe(true);
    expect(cfg.tools.webSearch.maxResults).toBe(5);
    expect(cfg.tools.webSearch.providers.tavily?.apiKey).toBe('tvly-1');
    expect(cfg.tools.webSearch.providers.tavily?.baseUrl).toBeUndefined();
  });

  it('enabled=true 但 provider 未定义时报错', () => {
    expect(() =>
      resolveConfig(
        { ...base, tools: { webSearch: { enabled: true, providers: {} } } },
        opts,
      ),
    ).toThrow(/未在 tools\.webSearch\.providers 中定义/);
  });

  it('enabled=true 但 env key 缺失时报错并指明环境变量名', () => {
    expect(() =>
      resolveConfig(
        {
          ...base,
          tools: {
            webSearch: {
              enabled: true,
              providers: { tavily: { apiKeyEnv: 'TAVILY_API_KEY' } },
            },
          },
        },
        opts,
      ),
    ).toThrow(/TAVILY_API_KEY/);
  });

  it('supportsTools 透传进 resolved entries', () => {
    const cfg = resolveConfig(
      {
        models: {
          entries: [
            { alias: 'a', provider: 'xai', model: 'm1' },
            { alias: 'b', provider: 'xai', model: 'm2', supportsTools: false },
          ],
        },
        providers: base.providers,
      },
      opts,
    );
    expect(cfg.models.entries[0]?.supportsTools).toBeUndefined();
    expect(cfg.models.entries[1]?.supportsTools).toBe(false);
  });
});
