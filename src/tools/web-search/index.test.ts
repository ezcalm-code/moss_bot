import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import { createWebSearchTool } from './index';
import { TavilyHttpError, type SearchProvider, type SearchResult } from './tavily';

const log = pino({ level: 'silent' });

let turnSeq = 0;

function ctxOf(chatId = 'c1', turnId = `t${++turnSeq}`): ToolContext {
  return {
    platform: 'telegram',
    chatId,
    senderId: 'u1',
    senderName: 'U1',
    isGroup: false,
    turnId,
    log,
  };
}

function fakeProvider(results: SearchResult[]) {
  const calls: string[] = [];
  const provider: SearchProvider = {
    id: 'fake',
    async search(query) {
      calls.push(query);
      return results;
    },
  };
  return { provider, calls };
}

function makeTool(
  provider: SearchProvider,
  now: () => number,
  cooldownMinutes = 5,
  maxResults = 5,
) {
  return createWebSearchTool({ provider, maxResults, cooldownMinutes, now });
}

describe('createWebSearchTool', () => {
  it('首次调用成功并格式化结果，published_date 标注为发布日期', async () => {
    const t = 0;
    const { provider, calls } = fakeProvider([
      { title: 'A', url: 'https://a', content: '内容A内容A', publishedDate: '2026-11-08T21:30:00Z' },
      { title: 'B', url: 'https://b', content: '内容B' },
    ]);
    const tool = makeTool(provider, () => t);
    const out = await tool.exec({ query: '北京天气' }, ctxOf());
    expect(calls).toEqual(['北京天气']);
    expect(out).toContain('[1] A（发布：2026-11-08）');
    expect(out).toContain('https://a');
    expect(out).toContain('内容A内容A');
    expect(out).toContain('[2] B\n'); // 无日期不标注
  });

  it('冷却期内返回剩余秒数，provider 不被调', async () => {
    let t = 0;
    const { provider, calls } = fakeProvider([{ title: 'A', url: 'https://a', content: 'x' }]);
    const tool = makeTool(provider, () => t);
    await tool.exec({ query: 'q1' }, ctxOf());
    t += 60_000;
    const out = await tool.exec({ query: 'q2' }, ctxOf());
    expect(calls).toHaveLength(1);
    expect(out).toContain('冷却');
    expect(out).toContain('剩余约 240 秒');
  });

  it('冷却结束后恢复调用', async () => {
    let t = 0;
    const { provider, calls } = fakeProvider([{ title: 'A', url: 'https://a', content: 'x' }]);
    const tool = makeTool(provider, () => t);
    await tool.exec({ query: 'q1' }, ctxOf());
    t += 5 * 60_000 + 1;
    await tool.exec({ query: 'q2' }, ctxOf());
    expect(calls).toHaveLength(2);
  });

  it('HTTP 失败（可能已计费）烧冷却窗口', async () => {
    let t = 0;
    let n = 0;
    const httpFail: SearchProvider = {
      id: 'bad',
      async search() {
        n++;
        throw new TavilyHttpError(429, 'Tavily HTTP 429: rate limited');
      },
    };
    const tool = makeTool(httpFail, () => t);
    const out = await tool.exec({ query: 'q' }, ctxOf());
    expect(out).toContain('web_search 执行失败');
    expect(out).toContain('429');
    t += 1000;
    const out2 = await tool.exec({ query: 'q' }, ctxOf());
    expect(out2).toContain('冷却'); // 已烧窗
    expect(n).toBe(1);
  });

  it('连接层失败（超时/DNS）未计费，回滚冷却窗允许立即重试', async () => {
    const t = 0;
    let n = 0;
    const flaky: SearchProvider = {
      id: 'flaky',
      async search() {
        n++;
        if (n === 1) throw new TypeError('fetch failed: Connect Timeout Error');
        return [{ title: 'A', url: 'https://a', content: 'x' }];
      },
    };
    const tool = makeTool(flaky, () => t);
    const out = await tool.exec({ query: 'q' }, ctxOf());
    expect(out).toContain('网络未连通');
    const out2 = await tool.exec({ query: 'q' }, ctxOf()); // 立即重试放行
    expect(out2).toContain('[1] A');
    expect(n).toBe(2);
  });

  it('query 缺失或为空返回参数错误，provider 不被调', async () => {
    const { provider, calls } = fakeProvider([]);
    const tool = makeTool(provider, () => 0);
    expect(await tool.exec({}, ctxOf())).toContain('参数错误');
    expect(await tool.exec({ query: '   ' }, ctxOf())).toContain('参数错误');
    expect(await tool.exec('not-object', ctxOf())).toContain('参数错误');
    expect(calls).toHaveLength(0);
  });

  it('空结果返回未搜索到说明', async () => {
    const { provider } = fakeProvider([]);
    const tool = makeTool(provider, () => 0);
    const out = await tool.exec({ query: 'xyz' }, ctxOf());
    expect(out).toContain('未搜索到');
    expect(out).toContain('xyz');
  });

  it('冷却按 chatId 隔离', async () => {
    const { provider, calls } = fakeProvider([{ title: 'A', url: 'https://a', content: 'x' }]);
    const tool = makeTool(provider, () => 0);
    await tool.exec({ query: 'q' }, ctxOf('c1'));
    await tool.exec({ query: 'q' }, ctxOf('c2'));
    expect(calls).toHaveLength(2);
  });

  it('同一 turn（agent 连招）内多次搜索放行，不受冷却限制', async () => {
    const { provider, calls } = fakeProvider([{ title: 'A', url: 'https://a', content: 'x' }]);
    const tool = makeTool(provider, () => 0);
    await tool.exec({ query: 'q1' }, ctxOf('c1', 'turn-7'));
    const out = await tool.exec({ query: 'q2' }, ctxOf('c1', 'turn-7')); // 同 turn
    expect(calls).toHaveLength(2);
    expect(out).toContain('[1] A');
  });
});
