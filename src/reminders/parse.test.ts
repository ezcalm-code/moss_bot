import { describe, expect, it } from 'vitest';
import { formatDisplay, parseRemindTime } from './parse';

// 固定「现在」：2026-11-09 15:00 local
const NOW = new Date(2026, 10, 9, 15, 0, 0).getTime();

describe('parseRemindTime', () => {
  it('HH:MM 今天未过 → 今天', () => {
    const r = parseRemindTime('18:30', NOW);
    expect(r?.dueAt).toBe(new Date(2026, 10, 9, 18, 30).getTime());
  });

  it('HH:MM 今天已过 → 顺延明天', () => {
    const r = parseRemindTime('09:00', NOW);
    expect(r?.dueAt).toBe(new Date(2026, 10, 10, 9, 0).getTime());
  });

  it('完整日期时间', () => {
    const r = parseRemindTime('2026-11-10 09:00', NOW);
    expect(r?.dueAt).toBe(new Date(2026, 10, 10, 9, 0).getTime());
  });

  it('MM-DD HH:MM 取当年', () => {
    const r = parseRemindTime('11-10 08:00', NOW);
    expect(r?.dueAt).toBe(new Date(2026, 10, 10, 8, 0).getTime());
  });

  it('过去的时间与乱串返回 undefined', () => {
    expect(parseRemindTime('2026-11-01 09:00', NOW)).toBeUndefined();
    expect(parseRemindTime('明天下午', NOW)).toBeUndefined();
    expect(parseRemindTime('', NOW)).toBeUndefined();
    expect(parseRemindTime('25:00', NOW)).toBeUndefined(); // Date 规格化非法值
  });

  it('formatDisplay 输出零填充', () => {
    expect(formatDisplay(new Date(2026, 10, 9, 8, 5))).toBe('2026-11-09 08:05');
  });
});
