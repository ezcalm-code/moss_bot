// 验证 OpenAI 兼容网关是否透传 tools 参数（function calling 硬前提，网关/模型升级后可复跑）
// 用法: node scripts/probe-gateway-tools.mjs [alias]
//   读 config.yaml（路径可用 MOSS_CONFIG 覆盖）的模型条目：端点/model 取自配置，key 取自 .env
//   默认探测 models.default；传 alias 可探测其他条目
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

try {
  process.loadEnvFile('.env');
} catch {
  // .env 不存在时依赖外部环境变量
}

const configPath = process.env.MOSS_CONFIG ?? 'config.yaml';
const cfg = parseYaml(readFileSync(configPath, 'utf8'));
const alias = process.argv[2] ?? cfg.models?.default ?? cfg.models?.entries?.[0]?.alias;
const entry = cfg.models?.entries?.find((e) => e.alias === alias);
if (!entry) {
  console.error(`配置中不存在模型 alias: ${alias}`);
  process.exit(1);
}
const provider = cfg.providers?.[entry.provider];
const key = process.env[provider?.apiKeyEnv ?? ''];
if (!provider?.baseUrl || !key) {
  console.error(`模型 "${alias}" 的 provider 缺少 baseUrl 或 API key（env: ${provider?.apiKeyEnv}）`);
  process.exit(1);
}
const base = provider.baseUrl.replace(/\/+$/, '');
const model = entry.model;
console.log(`探测目标: ${base}  模型: ${model}`);

const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网，获取实时或时效性信息。回答时事、价格、天气、新闻等需要最新信息的问题时应调用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    },
  },
];

async function post(body) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++;
  else fail++;
}

// 1. 非流式 + 应触发
try {
  const r = await post({ model, messages: [{ role: 'user', content: '今天北京天气怎么样？' }], tools });
  const msg = r.choices?.[0]?.message;
  const tc = msg?.tool_calls?.[0];
  check(
    '非流式: 应触发 tool_call',
    Boolean(tc),
    tc ? `${tc.function?.name} args=${tc.function?.arguments}` : `finish=${r.choices?.[0]?.finish_reason} content=${(msg?.content ?? '').slice(0, 80)}`,
  );
} catch (e) {
  check('非流式: 应触发 tool_call', false, String(e).slice(0, 200));
}

// 2. 非流式 + 不应触发（闲聊不搜索）
try {
  const r = await post({ model, messages: [{ role: 'user', content: '你好呀' }], tools });
  const msg = r.choices?.[0]?.message;
  check('非流式: 闲聊不触发', !msg?.tool_calls, msg?.tool_calls ? '误触发了' : (msg?.content ?? '').slice(0, 60));
} catch (e) {
  check('非流式: 闲聊不触发', false, String(e).slice(0, 200));
}

// 3. 工具结果回传（role: tool 二次调用）
try {
  const r1 = await post({ model, messages: [{ role: 'user', content: '今天北京天气怎么样？' }], tools });
  const tc = r1.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) {
    check('回传: role=tool 二次调用', false, '第一跳未产生 tool_call，跳过');
  } else {
    const r2 = await post({
      model,
      messages: [
        { role: 'user', content: '今天北京天气怎么样？' },
        { role: 'assistant', tool_calls: [tc] },
        { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ city: '北京', weather: '晴', temp: '12~20°C' }) },
      ],
    });
    const content = r2.choices?.[0]?.message?.content ?? '';
    check('回传: role=tool 二次调用', /晴|12|20/.test(content), content.slice(0, 80));
  }
} catch (e) {
  check('回传: role=tool 二次调用', false, String(e).slice(0, 200));
}

// 4. 流式 + tools（tool_call 以 delta 增量下发）
try {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: '今天北京天气怎么样？' }], tools, stream: true }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let name = '';
  let args = '';
  for await (const evt of readSse(res.body)) {
    const delta = evt.choices?.[0]?.delta;
    if (!delta) continue;
    for (const t of delta.tool_calls ?? []) {
      if (t.function?.name) name += t.function.name;
      if (t.function?.arguments) args += t.function.arguments;
    }
  }
  check('流式: tool_call 增量', Boolean(name || args), `name=${name} args=${args.slice(0, 80)}`);
} catch (e) {
  check('流式: tool_call 增量', false, String(e).slice(0, 200));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

async function* readSse(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // 忽略非 JSON 心流行
      }
    }
  }
}
