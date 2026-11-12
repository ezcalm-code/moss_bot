import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlatformId } from '../adapters/types';
import type { Logger } from '../log';

export interface Broadcast {
  id: string;
  platform: PlatformId;
  chatId: string;
  /** 每日触发时刻 HH:MM（零填充，按配置时区） */
  time: string;
  query: string;
  /** 创建时刻 epoch ms（旧记录可能缺失） */
  createdAt?: number;
  /** 触发当日去重：tz 内日期串 YYYY-MM-DD */
  lastFiredDay?: string;
}

export class BroadcastStore {
  private readonly path: string;

  constructor(
    dir: string,
    private readonly log: Logger,
  ) {
    this.path = join(dir, 'broadcasts.json');
  }

  load(): Broadcast[] {
    try {
      if (!existsSync(this.path)) return [];
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Broadcast[];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.log.warn({ err, path: this.path }, '播报数据文件损坏，按空处理');
      return [];
    }
  }

  save(list: readonly Broadcast[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(list, null, 2), 'utf8');
  }
}
