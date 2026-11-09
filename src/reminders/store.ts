import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../log';
import type { PlatformId } from '../adapters/types';

export interface Reminder {
  /** 短 id（8 位），/unremind 用 */
  id: string;
  platform: PlatformId;
  chatId: string;
  senderName: string;
  text: string;
  /** 到期时间（epoch ms） */
  dueAt: number;
  createdAt: number;
}

/** 生成 8 位短 id：时间戳36进制 + 随机，去掉小数点后取尾部，肉眼可抄写 */
export function newReminderId(): string {
  return Math.random().toString(36).slice(2, 6) + Date.now().toString(36).slice(-4);
}

/** 提醒持久化：单文件整读写（条数小）；照 FileSessionStore 的 best-effort 惯例，损坏不致命 */
export class ReminderStore {
  private readonly path: string;

  constructor(
    dir: string,
    private readonly log: Logger,
  ) {
    this.path = join(dir, 'reminders.json');
  }

  load(): Reminder[] {
    try {
      if (!existsSync(this.path)) return [];
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Reminder[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.log.warn({ err, path: this.path }, '提醒数据文件损坏，按空处理');
      return [];
    }
  }

  save(list: readonly Reminder[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(list, null, 2), 'utf8');
  }
}
