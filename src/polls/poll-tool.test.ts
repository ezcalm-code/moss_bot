import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tools/types';
import { createCreatePollTool } from './poll-tool';
import type { PollsService } from './service';

const log = pino({ level: 'silent' });
const ctx: ToolContext = {
  platform: 'telegram',
  chatId: 'c',
  senderId: 'u',
  senderName: 'U',
  isGroup: false,
  turnId: 't',
  log,
};

function fakeService() {
  const calls: { question: string; options: string[] }[] = [];
  const service = {
    async createPoll(_platform: unknown, _chatId: unknown, question: string, options: string[]) {
      calls.push({ question, options });
      return 'poll0001';
    },
  } as unknown as PollsService;
  return { service, calls };
}

describe('createCreatePollTool', () => {
  it('合法参数发起投票', async () => {
    const { service, calls } = fakeService();
    const tool = createCreatePollTool({ service });
    const out = await tool.exec(
      { question: '今晚吃什么', options: ['火锅', '烧烤'] },
      ctx,
    );
    expect(calls).toEqual([{ question: '今晚吃什么', options: ['火锅', '烧烤'] }]);
    expect(out).toContain('已发起');
  });

  it('选项不足/缺失问题返回错误串，service 不被调', async () => {
    const { service, calls } = fakeService();
    const tool = createCreatePollTool({ service });
    expect(await tool.exec({ question: 'q', options: ['只有一个'] }, ctx)).toContain('参数错误');
    expect(await tool.exec({ options: ['a', 'b'] }, ctx)).toContain('参数错误');
    expect(await tool.exec({ question: 'q', options: ['a', '', '  '] }, ctx)).toContain('参数错误');
    expect(calls).toHaveLength(0);
  });

  it('service 抛错（平台不支持）转错误说明', async () => {
    const service = {
      async createPoll() {
        throw new Error('当前平台不支持投票');
      },
    } as unknown as PollsService;
    const tool = createCreatePollTool({ service });
    const out = await tool.exec({ question: 'q', options: ['a', 'b'] }, ctx);
    expect(out).toContain('当前平台不支持投票');
  });
});
