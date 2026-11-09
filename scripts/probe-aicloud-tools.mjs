// 验证 OpenAI 兼容网关是否透传 tools 参数（方案B硬前提，网关升级后可复跑）
// 用法: node scripts/probe-aicloud-tools.mjs   （读取仓库根 .env 的 AICLOUD_API_KEY）
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m && !line.trim().startsWith('#')) {
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const key = env.AICLOUD_API_KEY;
if (!key) {
  console.error('未找到 AICLOUD_API_KEY');
  process.exit(1);
}

const base = 'https://aicloud-api.jdocloud.com/v1';
const model = 'glm/glm-5.3-flash';
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
