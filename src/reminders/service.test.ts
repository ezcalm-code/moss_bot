import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ReminderService, type ReminderDispatch } from './service';
import { ReminderStore } from './store';

const log = pino({ level: 'silent' });
const tmpDirs: string[] = [];

function makeService(): ReminderService {
  const dir = mkdtempSync(join(tmpdir(), 'moss-rem-'));
  tmpDirs.push(dir);
  return new ReminderService(new ReminderStore(dir, log), log);
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const BASE = {
  platform: 'telegram' as const,
  chatId: 'c1',
  senderName: 'Alice',
  text: '喝水',
};

describe('ReminderService', () => {
  it('add 校验：过去时间与 NaN 拒绝，未来成功', () => {
    const svc = makeService();
    expect(() => svc.add({ ...BASE, dueAt: Date.now() - 1000 })).toThrow(/过去/);
    expect(() => svc.add({ ...BASE, dueAt: NaN })).toThrow(/格式/);
    const r = svc.add({ ...BASE, dueAt: Date.now() + 60_000 });
    expect(r.id).toHaveLength(8);
    expect(svc.listByChat('c1')).toHaveLength(1);
  });

  it('listByChat 按 chatId 隔离，cancel 跨会话不可删', () => {
    const svc = makeService();
    svc.add({ ...BASE, chatId: 'c1', dueAt: Date.now() + 60_000 });
    svc.add({ ...BASE, chatId: 'c2', dueAt: Date.now() + 60_000 });
    expect(svc.listByChat('c1')).toHaveLength(1);
    expect(svc.listByChat('c2')).toHaveLength(1);
    const id = svc.listByChat('c1')[0]?.id ?? '';
    expect(svc.cancel(id, 'c2')).toBe(false); // 跨会话取消不了
    expect(svc.listByChat('c1')).toHaveLength(1);
    expect(svc.cancel(id, 'c1')).toBe(true);
    expect(svc.listByChat('c1')).toHaveLength(0);
  });

  it('到点投递并从清单移除；未到点不动', async () => {
    const svc = makeService();
    const base = Date.now();
    svc.add({ ...BASE, dueAt: base + 1000 });
    svc.add({ ...BASE, dueAt: base + 9000 });
    const sent: string[] = [];
    const dispatch: ReminderDispatch = async (platform, chatId, text) => {
      sent.push(`${platform}:${chatId}:${text}`);
    };
    await svc.scanNow(dispatch, base + 2000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('telegram:c1:');
    expect(sent[0]).toContain('⏰');
    expect(sent[0]).toContain('喝水');
    expect(svc.listByChat('c1')).toHaveLength(1); // 另一条未到点保留
  });

  it('投递失败保留记录，下轮重试', async () => {
    const svc = makeService();
    const base = Date.now();
    svc.add({ ...BASE, dueAt: base + 1000 });
    let attempts = 0;
    const dispatch: ReminderDispatch = async () => {
      attempts++;
      if (attempts === 1) throw new Error('platform down');
    };
    await svc.scanNow(dispatch, base + 2000);
    expect(svc.listByChat('c1')).toHaveLength(1); // 失败保留
    await svc.scanNow(dispatch, base + 3000);
    expect(attempts).toBe(2);
    expect(svc.listByChat('c1')).toHaveLength(0); // 重试成功后移除
  });

  it('重启后从盘上恢复（新 service 实例读到旧数据）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moss-rem-'));
    tmpDirs.push(dir);
    const svc1 = new ReminderService(new ReminderStore(dir, log), log);
    svc1.add({ ...BASE, dueAt: Date.now() + 60_000 });
    const svc2 = new ReminderService(new ReminderStore(dir, log), log);
    expect(svc2.listByChat('c1')).toHaveLength(1);
  });
});
