import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';
import { newReminderId, ReminderStore, type Reminder } from './store';

export type ReminderDispatch = (
  platform: PlatformId,
  chatId: string,
  text: string,
) => Promise<void>;

const SCAN_INTERVAL_MS = 30_000;

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 提醒调度：持久化任务表 + 周期扫描投递；投递失败保留待下轮重试，进程重启后自动恢复 */
export class ReminderService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ReminderStore,
    private readonly log: Logger,
  ) {}

  /** 设提醒；dueAt 必须是有效且未来的时间，否则 throw（调用方转用户提示） */
  add(input: {
    platform: PlatformId;
    chatId: string;
    senderName: string;
    text: string;
    dueAt: number;
  }): Reminder {
    if (!Number.isFinite(input.dueAt)) {
      throw new Error('时间格式不对，没法解析');
    }
    if (input.dueAt <= Date.now()) {
      throw new Error('这个时间已经过去了，设个未来的时间吧');
    }
    const reminder: Reminder = {
      id: newReminderId(),
      platform: input.platform,
      chatId: input.chatId,
      senderName: input.senderName,
      text: input.text,
      dueAt: input.dueAt,
      createdAt: Date.now(),
    };
    const list = this.store.load();
    list.push(reminder);
    this.store.save(list);
    return reminder;
  }

  listByChat(chatId: string): Reminder[] {
    return this.store
      .load()
      .filter((r) => r.chatId === chatId)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 取消；chatId 不匹配视为不存在（不允许跨会话乱删） */
  cancel(id: string, chatId: string): boolean {
    const list = this.store.load();
    const next = list.filter((r) => !(r.id === id && r.chatId === chatId));
    if (next.length === list.length) return false;
    this.store.save(next);
    return true;
  }

  /** 启动扫描；先补投错过期的（带过期标记），失败保留待下轮重试 */
  start(dispatch: ReminderDispatch): void {
    void this.dispatchDue(dispatch, Date.now(), true);
    this.timer = setInterval(() => {
      void this.dispatchDue(dispatch, Date.now(), false);
    }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async dispatchDue(
    dispatch: ReminderDispatch,
    now: number,
    catchingUp: boolean,
  ): Promise<void> {
    const due = this.store.load().filter((r) => r.dueAt <= now);
    if (due.length > 0) {
      this.log.info({ count: due.length, catchingUp }, '提醒到期投递');
    }
    for (const r of due) {
      const prefix = catchingUp ? `[过期提醒 · 原定 ${formatTime(r.dueAt)}]\n` : '';
      const text = `${prefix}⏰ 提醒（来自 ${r.senderName}）：${r.text}`;
      try {
        await dispatch(r.platform, r.chatId, text);
        this.store.save(this.store.load().filter((x) => x.id !== r.id));
      } catch (err) {
        // 保留记录下轮重试；连续失败也不会丢提醒
        this.log.warn({ err, id: r.id, platform: r.platform }, '提醒投递失败，待下轮重试');
      }
    }
  }

  /** 测试辅助：直接触发一次扫描 */
  async scanNow(dispatch: ReminderDispatch, now = Date.now()): Promise<void> {
    await this.dispatchDue(dispatch, now, false);
  }
}
