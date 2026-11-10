import { randomUUID } from 'node:crypto';
import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';
import { dayStringInTz, zonedNow } from '../time';
import { BroadcastStore, type Broadcast } from './store';

export type BroadcastDispatch = (platform: PlatformId, chatId: string, text: string) => Promise<void>;

/** 到点内容生成：搜索 + 摘要在装配方组装，service 只管调度 */
export type BroadcastGenerate = (b: Broadcast) => Promise<string>;

const SCAN_INTERVAL_MS = 30_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function isValidBroadcastTime(time: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

export function normalizeBroadcastTime(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return time;
  return `${pad(Number(m[1]))}:${m[2]}`;
}

/**
 * 每日播报调度：到点（配置时区）触发内容生成并推送；当日去重（lastFiredDay），
 * 生成失败也记当日——失败后当天不再重试，防故障刷屏。
 */
export class BroadcastService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: BroadcastStore,
    private readonly timezone: string | undefined,
    private readonly log: Logger,
  ) {}

  add(input: { platform: PlatformId; chatId: string; query: string; time: string }): Broadcast {
    if (!isValidBroadcastTime(input.time)) {
      throw new Error('时间格式不对，请用 HH:MM（如 09:00）');
    }
    const time = normalizeBroadcastTime(input.time);
    const broadcast: Broadcast = {
      id: randomUUID().slice(0, 8),
      platform: input.platform,
      chatId: input.chatId,
      time,
      query: input.query.trim(),
    };
    if (!broadcast.query) throw new Error('播报内容（query）不能为空');
    const list = this.store.load();
    list.push(broadcast);
    this.store.save(list);
    return broadcast;
  }

  listByChat(chatId: string): Broadcast[] {
    return this.store
      .load()
      .filter((b) => b.chatId === chatId)
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  cancel(id: string, chatId: string): boolean {
    const list = this.store.load();
    const next = list.filter((b) => !(b.id === id && b.chatId === chatId));
    if (next.length === list.length) return false;
    this.store.save(next);
    return true;
  }

  start(dispatch: BroadcastDispatch, generate: BroadcastGenerate): void {
    const tick = (): void => {
      void this.scanOnce(Date.now(), dispatch, generate).catch((err) => {
        this.log.warn({ err }, '播报扫描异常');
      });
    };
    tick();
    this.timer = setInterval(tick, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 测试辅助：指定时刻扫描一次 */
  async scanOnce(nowMs: number, dispatch: BroadcastDispatch, generate: BroadcastGenerate): Promise<void> {
    const today = dayStringInTz(this.timezone, nowMs);
    const wall = zonedNow(this.timezone, nowMs);
    const nowHHMM = `${pad(wall.hour)}:${pad(wall.minute)}`;
    const due = this.store.load().filter((b) => b.lastFiredDay !== today && b.time <= nowHHMM);
    for (const b of due) {
      // 先记当日再生成：失败也当天不重试，防故障场景反复推送
      b.lastFiredDay = today;
      this.store.save(this.store.load().map((x) => (x.id === b.id ? b : x)));
      let text: string;
      try {
        text = await generate(b);
      } catch (err) {
        this.log.warn({ err, id: b.id }, '播报内容生成失败');
        text = `今日播报生成失败（${err instanceof Error ? err.message : String(err)}）。`;
      }
      try {
        await dispatch(b.platform, b.chatId, `📰 每日播报（${b.time}）：\n\n${text}`);
      } catch (err) {
        this.log.warn({ err, id: b.id }, '播报推送失败');
      }
    }
  }
}
