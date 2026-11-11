import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../tools/types';
import { createListScheduleTool } from './list-tool';
import type { BroadcastService } from '../broadcasts/service';
import type { ReminderService } from '../reminders/service';
import type { Reminder } from '../reminders/store';
import type { Broadcast } from '../broadcasts/store';

const log = pino({ level: 'silent' });
const ctx: ToolContext = {
  platform: 'telegram',
  chatId: 'c1',
  senderId: 'u1',
  senderName: 'U',
  isGroup: false,
  turnId: 't',
  log,
};

function makeServices(reminders: Reminder[], broadcasts: Broadcast[]) {
  const reminderSvc = {
    listByChat: (chatId: string) => reminders.filter((r) => r.chatId === chatId),
  } as unknown as ReminderService;
  const broadcastSvc = {
    listByChat: (chatId: string) => broadcasts.filter((b) => b.chatId === chatId),
  } as unknown as BroadcastService;
  return { reminderSvc, broadcastSvc };
}

const R1: Reminder = {
  id: 'rem0001',
  platform: 'telegram',
  chatId: 'c1',
  senderName: 'U',
  text: '龙哥生日',
  dueAt: Date.UTC(2026, 10, 19, 1, 0),
  createdAt: Date.UTC(2026, 10, 10, 16, 26),
};
const B1: Broadcast = {
  id: 'bc00001',
  platform: 'telegram',
  chatId: 'c1',
  time: '09:30',
  query: 'CN瓦转会期日报',
};

describe('createListScheduleTool', () => {
  it('实时返回定时提醒与每日播报两个分区，带截至时刻', async () => {
    const { reminderSvc, broadcastSvc } = makeServices([R1], [B1]);
    const tool = createListScheduleTool({
      reminders: reminderSvc,
      broadcasts: broadcastSvc,
      timezone: 'Asia/Shanghai',
    });
    const out = await tool.exec({}, ctx);
    expect(out).toContain('截至');
    expect(out).toContain('【定时提醒】');
    expect(out).toContain('龙哥生日');
    expect(out).toContain('【每日播报】');
    expect(out).toContain('CN瓦转会期日报');
  });

  it('两者皆空返回无定时任务说明', async () => {
    const { reminderSvc, broadcastSvc } = makeServices([], []);
    const tool = createListScheduleTool({
      reminders: reminderSvc,
      broadcasts: broadcastSvc,
      timezone: 'Asia/Shanghai',
    });
    const out = await tool.exec({}, ctx);
    expect(out).toContain('没有任何定时提醒或每日播报');
  });
});
