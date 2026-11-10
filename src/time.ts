/** 时区工具：定时提醒、每日播报、时间注入统一走这里；tz 缺省 = 进程本地时区 */

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0=周日 */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** 校验 IANA 时区名；非法返回 false（配置校验用） */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedNow(timezone: string | undefined, now = Date.now()): ZonedParts {
  const d = new Date(now);
  if (!timezone) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday: d.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    weekday: WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''] ?? 0,
  };
}

/** 该时区在该时刻的 UTC 偏移（毫秒，东正西负）；DST 折点附近不精确，本项目目标场景（CN）无 DST */
export function tzOffsetMs(timezone: string, utcMs: number): number {
  const p = zonedNow(timezone, utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs;
}

/** 下一个 tz 时区 HH:MM 的 epoch（当天的已过则明天） */
export function nextOccurrenceAt(timezone: string | undefined, hour: number, minute: number, nowMs: number): number {
  const offset = timezone ? tzOffsetMs(timezone, nowMs) : -new Date(nowMs).getTimezoneOffset() * 60_000;
  const wallAsUtc = nowMs + offset;
  const base = new Date(wallAsUtc);
  base.setUTCHours(hour, minute, 0, 0);
  let target = base.getTime() - offset;
  if (target <= nowMs) {
    target += 86_400_000;
  }
  return target;
}

/** tz 时区的 YYYY-MM-DD 串（每日播报的当日去重用） */
export function dayStringInTz(timezone: string | undefined, nowMs = Date.now()): string {
  const p = zonedNow(timezone, nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
