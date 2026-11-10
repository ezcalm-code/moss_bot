import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { BroadcastDispatch, BroadcastGenerate } from './service';
import { BroadcastService, isValidBroadcastTime } from './service';
import { BroadcastStore } from './store';

const log = pino({ level: 'silent' });
const tmpDirs: string[] = [];

function makeService(): BroadcastService {
  const dir = mkdtempSync(join(tmpdir(), 'moss-bc-'));
  tmpDirs.push(dir);
  return new BroadcastService(new BroadcastStore(dir, log), undefined, log);
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// 本地 2026-11-09 09:30（本地时区构造，scanOnce 用本地墙钟比较）
const NOW = new Date(2026, 10, 9, 9, 30, 0).getTime();

describe('isValidBroadcastTime', () => {
  it('HH:MM 合法、越界与乱串拒绝', () => {
    expect(isValidBroadcastTime('09:00')).toBe(true);
    expect(isValidBroadcastTime('9:00')).toBe(true);
    expect(isValidBroadcastTime('24:00')).toBe(false);
    expect(isValidBroadcastTime('9:5')).toBe(false);
    expect(isValidBroadcastTime('morning')).toBe(false);
  });
});

describe('BroadcastService', () => {
  it('add 校验时间格式并零填充', () => {
    const svc = makeService();
    const b = svc.add({ platform: 'telegram', chatId: 'c1', query: 'AI新闻', time: '9:30' });
    expect(b.time).toBe('09:30');
    expect(() => svc.add({ platform: 'telegram', chatId: 'c1', query: 'x', time: '25:00' })).toThrow(/HH:MM/);
  });

  it('到点触发生成与推送，当日去重', async () => {
    const svc = makeService();
    svc.add({ platform: 'telegram', chatId: 'c1', query: 'AI新闻', time: '09:00' });
    let generated = 0;
    const generate: BroadcastGenerate = async () => {
      generated++;
      return '今日摘要';
    };
    const sent: string[] = [];
    const dispatch: BroadcastDispatch = async (_p, _c, text) => {
      sent.push(text);
    };
    // 08:59 未到点
    await svc.scanOnce(new Date(2026, 10, 9, 8, 59).getTime(), dispatch, generate);
    expect(sent).toHaveLength(0);
    // 09:30 到点 → 触发
    await svc.scanOnce(NOW, dispatch, generate);
    expect(generated).toBe(1);
    expect(sent[0]).toContain('📰');
    expect(sent[0]).toContain('今日摘要');
    // 同日再扫 → 不重复
    await svc.scanOnce(new Date(2026, 10, 9, 20, 0).getTime(), dispatch, generate);
    expect(generated).toBe(1);
  });

  it('生成失败推送失败说明且当日不再重试', async () => {
    const svc = makeService();
    svc.add({ platform: 'telegram', chatId: 'c1', query: 'q', time: '09:00' });
    const generate: BroadcastGenerate = async () => {
      throw new Error('search down');
    };
    const sent: string[] = [];
    const dispatch: BroadcastDispatch = async (_p, _c, text) => {
      sent.push(text);
    };
    await svc.scanOnce(NOW, dispatch, generate);
    expect(sent[0]).toContain('生成失败');
    expect(sent[0]).toContain('search down');
    await svc.scanOnce(new Date(2026, 10, 9, 18, 0).getTime(), dispatch, generate);
    expect(sent).toHaveLength(1); // 当日不再触发
  });

  it('按 chatId 隔离与取消', () => {
    const svc = makeService();
    const a = svc.add({ platform: 'telegram', chatId: 'c1', query: 'qa', time: '09:00' });
    svc.add({ platform: 'telegram', chatId: 'c2', query: 'qb', time: '10:00' });
    expect(svc.listByChat('c1')).toHaveLength(1);
    expect(svc.cancel(a.id, 'c2')).toBe(false);
    expect(svc.cancel(a.id, 'c1')).toBe(true);
    expect(svc.listByChat('c1')).toHaveLength(0);
  });
});
