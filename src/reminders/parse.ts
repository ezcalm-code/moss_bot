import { nextOccurrenceAt, tzOffsetMs, zonedNow } from '../time';

/** /remind 命令的时间解析（确定性路径）；工具路径由模型出 ISO，各自独立 */

export interface ParsedRemindTime {
  dueAt: number;
  /** 给用户看的时间串（按配置时区） */
  display: string;
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * 支持：HH:MM（今天，已过则顺延明天）、YYYY-MM-DD HH:MM、MM-DD HH:MM（当年）。
 * 「今天/当年」与展示串按 timezone（缺省进程本地）计算。解析失败返回 undefined。
 */
export function parseRemindTime(
  input: string,
  now = Date.now(),
  timezone?: string,
): ParsedRemindTime | undefined {
  let m = /^(\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return undefined;
    const dueAt = nextOccurrenceAt(timezone, hour, minute, now);
    return { dueAt, display: formatDisplay(dueAt, timezone) };
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    return fromParts(m, true, now, timezone);
  }
  m = /^(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    return fromParts(m, false, now, timezone);
  }
  return undefined;
}

function wallToEpoch(timezone: string | undefined, p: WallParts, nowMs: number): number {
  const offset = timezone
    ? tzOffsetMs(timezone, nowMs)
    : -new Date(nowMs).getTimezoneOffset() * 60_000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - offset;
}

function fromParts(
  m: RegExpExecArray,
  withYear: boolean,
  now: number,
  timezone?: string,
): ParsedRemindTime | undefined {
  const parts: WallParts = {
    year: withYear ? Number(m[1]) : zonedNow(timezone, now).year,
    month: Number(withYear ? m[2] : m[1]),
    day: Number(withYear ? m[3] : m[2]),
    hour: Number(withYear ? m[4] : m[3]),
    minute: Number(withYear ? m[5] : m[4]),
  };
  // Date 构造会把越界值静默规格化（25:00→次日1点、2月30→3月2日），round-trip 校验拒绝之
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const roundTrip =
    check.getUTCFullYear() === parts.year &&
    check.getUTCMonth() + 1 === parts.month &&
    check.getUTCDate() === parts.day;
  if (!roundTrip || parts.hour > 23 || parts.minute > 59) return undefined;
  const dueAt = wallToEpoch(timezone, parts, now);
  if (dueAt <= now) return undefined;
  return { dueAt, display: formatDisplay(dueAt, timezone) };
}

/** 按时区展示 YYYY-MM-DD HH:MM */
export function formatDisplay(epochMs: number, timezone?: string): string {
  const p = zonedNow(timezone, epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
