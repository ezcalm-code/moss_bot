import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ToolRunner, toFunctionTool } from './index';
import type { ToolSpec } from './types';

const log = pino({ level: 'silent' });
const ctx = { platform: 'telegram', chatId: 'c', senderId: 'u', isGroup: false, log } as const;

const echo: ToolSpec = {
  name: 'echo_tool',
  description: 'echo',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async exec(args) {
    return `echo:${(args as { text: string }).text}`;
  },
};

describe('ToolRunner', () => {
  it('specs/toFunctionTool 暴露 wire 形状', () => {
    const runner = new ToolRunner([echo]);
    expect(runner.has('echo_tool')).toBe(true);
    const def = toFunctionTool(echo);
    expect(def).toEqual({
      type: 'function',
      function: { name: 'echo_tool', description: 'echo', parameters: echo.parameters },
    });
  });

  it('合法 JSON 参数透传', async () => {
    const runner = new ToolRunner([echo]);
    expect(await runner.exec('echo_tool', '{"text":"hi"}', ctx)).toBe('echo:hi');
  });

  it('未知工具返回错误串且不 throw', async () => {
    const runner = new ToolRunner([echo]);
    const out = await runner.exec('nope', '{}', ctx);
    expect(out).toContain('未知工具');
    expect(out).toContain('echo_tool');
  });

  it('非法 JSON 返回参数错误串，exec 不被调', async () => {
    let called = 0;
    const spy: ToolSpec = {
      ...echo,
      async exec() {
        called++;
        return '';
      },
    };
    const runner = new ToolRunner([spy]);
    const out = await runner.exec('echo_tool', '{oops', ctx);
    expect(out).toContain('不是合法 JSON');
    expect(called).toBe(0);
  });

  it('exec 抛错被兜底为错误串', async () => {
    const bad: ToolSpec = {
      ...echo,
      async exec() {
        throw new Error('kaboom');
      },
    };
    const runner = new ToolRunner([bad]);
    expect(await runner.exec('echo_tool', '{}', ctx)).toContain('kaboom');
  });

  it('超长结果截断并标注', async () => {
    const long: ToolSpec = {
      ...echo,
      async exec() {
        return 'x'.repeat(5000);
      },
    };
    const runner = new ToolRunner([long]);
    const out = await runner.exec('echo_tool', '{}', ctx);
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('已截断');
  });
});
