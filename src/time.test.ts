import { describe, expect, it } from 'vitest';
import { dayStringInTz, isValidTimezone, nextOccurrenceAt, zonedNow } from './time';

// 2026-11-09 16:30 UTC（北京 11-10 00:30，纽约 11-09 11:30）——跨日时刻
const NOW = Date.UTC(2026, 10, 9, 16, 30, 0);

describe('zonedNow', () => {
  it('按 IANA 时区取墙钟各分量', () => {
    const sh = zonedNow('Asia/Shanghai', NOW);
    expect([sh.year, sh.month, sh.day, sh.hour, sh.minute]).toEqual([2026, 11, 10, 0, 30]);
    expect(sh.weekday).toBe(2); // 北京已是周二凌晨
    const ny = zonedNow('America/New_York', NOW);
    expect([ny.year, ny.month, ny.day, ny.hour]).toEqual([2026, 11, 9, 11]);
    expect(ny.weekday).toBe(1); // 纽约还是周一
  });

  it('缺省时区用进程本地', () => {
    const p = zonedNow(undefined, NOW);
    const local = new Date(NOW);
    expect(p.hour).toBe(local.getHours());
  });

  it('非法时区被识别', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('nextOccurrenceAt', () => {
  it('当天未过 → 今天该时刻', () => {
    // 北京 00:30，问当天 09:00 → 11-10 09:00
    const due = nextOccurrenceAt('Asia/Shanghai', 9, 0, NOW);
    const p = zonedNow('Asia/Shanghai', due);
    expect([p.month, p.day, p.hour, p.minute]).toEqual([11, 10, 9, 0]);
  });

  it('当天已过 → 明天同一时刻', () => {
    // 北京 00:30，问 00:00（刚过）→ 11-11 00:00
    const due = nextOccurrenceAt('Asia/Shanghai', 0, 0, NOW);
    const p = zonedNow('Asia/Shanghai', due);
    expect([p.month, p.day, p.hour]).toEqual([11, 11, 0]);
  });
});

describe('dayStringInTz', () => {
  it('同一时刻在 UTC 与北京是不同日期串', () => {
    expect(dayStringInTz('UTC', NOW)).toBe('2026-11-09');
    expect(dayStringInTz('Asia/Shanghai', NOW)).toBe('2026-11-10');
  });
});
