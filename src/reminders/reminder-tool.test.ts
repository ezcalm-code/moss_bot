import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tools/types';
import type { ReminderService } from './service';
import { createReminderTool } from './reminder-tool';

const log = pino({ level: 'silent' });
const ctx: ToolContext = {
  platform: 'telegram',
  chatId: 'c1',
  senderId: 'u1',
  senderName: 'Alice',
  isGroup: false,
  turnId: 't1',
  log,
};

function fakeService() {
  const added: string[] = [];
  const service = {
    add(input: { text: string }) {
      added.push(input.text);
      return { id: 'abcd1234' };
    },
  } as unknown as ReminderService;
  return { service, added };
}

describe('createReminderTool', () => {
  it('合法参数设置成功并返回 id', async () => {
    const { service, added } = fakeService();
    const tool = createReminderTool({ service });
    const out = await tool.exec({ datetime: '2026-11-10T09:00', text: '喝水' }, ctx);
    expect(added).toEqual(['喝水']);
    expect(out).toContain('abcd1234');
    expect(out).toContain('喝水');
  });

  it('非法/缺失参数返回错误说明，service 不被调', async () => {
    const { service, added } = fakeService();
    const tool = createReminderTool({ service });
    expect(await tool.exec({ datetime: 'not-a-time', text: 'x' }, ctx)).toContain('无法把');
    expect(await tool.exec({ text: 'x' }, ctx)).toContain('参数错误');
    expect(await tool.exec({ datetime: '2026-11-10T09:00' }, ctx)).toContain('参数错误');
    expect(added).toHaveLength(0);
  });
});
