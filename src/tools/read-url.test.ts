import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ToolContext, PageExtractor } from './types';
import { createReadUrlTool } from './read-url';

const log = pino({ level: 'silent' });
const ctx: ToolContext = {
  platform: 'telegram',
  chatId: 'c',
  senderId: 'u',
  isGroup: false,
  log,
};

function fakeExtractor(content: string | Error) {
  const calls: string[] = [];
  const extractor: PageExtractor = {
    id: 'fake',
    async extract(url) {
      calls.push(url);
      if (content instanceof Error) throw content;
      return content;
    },
  };
  return { extractor, calls };
}

describe('createReadUrlTool', () => {
  it('合法链接返回带出处标注的正文', async () => {
    const { extractor, calls } = fakeExtractor('这是正文');
    const tool = createReadUrlTool({ extractor });
    const out = await tool.exec({ url: 'https://example.com/a' }, ctx);
    expect(calls).toEqual(['https://example.com/a']);
    expect(out).toContain('[链接] https://example.com/a');
    expect(out).toContain('这是正文');
  });

  it('非法与费 http(s) 协议返回参数错误，extractor 不被调', async () => {
    const { extractor, calls } = fakeExtractor('x');
    const tool = createReadUrlTool({ extractor });
    expect(await tool.exec({}, ctx)).toContain('参数错误');
    expect(await tool.exec({ url: '不是链接' }, ctx)).toContain('参数错误');
    expect(await tool.exec({ url: 'ftp://example.com/f' }, ctx)).toContain('只支持 http/https');
    expect(calls).toHaveLength(0);
  });

  it('extractor 抛错转失败说明串', async () => {
    const { extractor } = fakeExtractor(new Error('extraction failed'));
    const tool = createReadUrlTool({ extractor });
    const out = await tool.exec({ url: 'https://a' }, ctx);
    expect(out).toContain('read_url 执行失败');
    expect(out).toContain('extraction failed');
  });

  it('正文超长截断到 maxChars', async () => {
    const { extractor } = fakeExtractor('x'.repeat(9999));
    const tool = createReadUrlTool({ extractor, maxChars: 100 });
    const out = await tool.exec({ url: 'https://a' }, ctx);
    expect(out.length).toBeLessThan(150);
  });
});
