import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../log';
import type { SessionData, SessionStore } from './types';

/** best-effort 落盘：读写失败只记日志，不向上抛（会话丢失可接受，进程崩溃不可接受） */
export class FileSessionStore implements SessionStore {
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  private pathFor(key: string): string {
    return join(this.dir, `${encodeURIComponent(key)}.json`);
  }

  async load(key: string): Promise<SessionData | undefined> {
    const p = this.pathFor(key);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as SessionData;
    } catch (err) {
      this.log.warn({ err, path: p }, 'session 文件损坏，按空会话处理');
      return undefined;
    }
  }

  async save(session: SessionData): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.pathFor(session.key), JSON.stringify(session), 'utf8');
    } catch (err) {
      this.log.warn({ err, key: session.key }, 'session 落盘失败');
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch (err) {
      this.log.warn({ err, path: p }, 'session 删除失败');
    }
  }
}
