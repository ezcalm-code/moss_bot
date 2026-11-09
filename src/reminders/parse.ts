/** /remind 命令的时间解析（确定性路径）；工具路径由模型出 ISO，各自独立 */

export interface ParsedRemindTime {
  dueAt: number;
  /** 给用户看的时间串 */
  display: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 支持：HH:MM（今天，已过则顺延明天）、YYYY-MM-DD HH:MM、MM-DD HH:MM（当年）。
 * 解析失败返回 undefined（调用方给用法提示）。
 */
export function parseRemindTime(input: string, now = Date.now()): ParsedRemindTime | undefined {
  const d = new Date(now);
  let m = /^(\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return undefined;
    const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute);
    if (due.getTime() <= now) due.setDate(due.getDate() + 1);
    return { dueAt: due.getTime(), display: formatDisplay(due) };
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    return fromParts(d, m, true);
  }
  m = /^(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/.exec(input);
  if (m) {
    return fromParts(d, m, false);
  }
  return undefined;
}

function fromParts(
  d: Date,
  m: RegExpExecArray,
  withYear: boolean,
): ParsedRemindTime | undefined {
  const year = withYear ? Number(m[1]) : d.getFullYear();
  const month = Number(withYear ? m[2] : m[1]) - 1;
  const day = Number(withYear ? m[3] : m[2]);
  const hour = Number(withYear ? m[4] : m[3]);
  const minute = Number(withYear ? m[5] : m[4]);
  // Date 构造会把越界值静默规格化（25:00→次日1点、2月30→3月2日），round-trip 校验拒绝之
  const due = new Date(year, month, day, hour, minute);
  const roundTrip =
    due.getFullYear() === year && due.getMonth() === month && due.getDate() === day;
  if (!roundTrip || hour > 23 || minute > 59) return undefined;
  if (due.getTime() <= d.getTime()) return undefined;
  return { dueAt: due.getTime(), display: formatDisplay(due) };
}

export function formatDisplay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
