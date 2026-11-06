import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSessionStore } from './file';
import { MemorySessionStore } from './memory';
import { SessionManager } from '../core/session';
import { sessionKey } from './types';

const silentLog = pino({ level: 'silent' });

describe('SessionManager', () => {
  it('未超过上限不裁剪', () => {
    const mgr = new SessionManager(new MemorySessionStore(), 6);
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      content: String(i),
    }));
    expect(mgr.trim(history)).toHaveLength(6);
  });

  it('超过 maxHistoryMessages 裁掉最旧的消息（AC2.4）', () => {
    const mgr = new SessionManager(new MemorySessionStore(), 4);
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg-${i}`,
    }));
    const trimmed = mgr.trim(history);
    expect(trimmed).toHaveLength(4);
    expect(trimmed[0]?.content).toBe('msg-4');
    expect(trimmed.at(-1)?.content).toBe('msg-7');
  });

  it('appendTurn 保存 user/assistant 轮次', async () => {
    const store = new MemorySessionStore();
    const mgr = new SessionManager(store, 6);
    const session = await mgr.get('telegram', '42');
    await mgr.appendTurn(
      session,
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    );
    const loaded = await store.load(sessionKey('telegram', '42'));
    expect(loaded?.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('reset 删除会话', async () => {
    const store = new MemorySessionStore();
    const mgr = new SessionManager(store, 6);
    const session = await mgr.get('telegram', '42');
    await mgr.appendTurn(
      session,
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    );
    await mgr.reset('telegram', '42');
    expect(await store.load(sessionKey('telegram', '42'))).toBeUndefined();
  });
});

describe('FileSessionStore', () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'moss-sessions-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('save/load 往返（AC2.5 存储基础）', async () => {
    const store = new FileSessionStore(newDir(), silentLog);
    const data = {
      key: 'telegram:42',
      history: [
        { role: 'user' as const, content: 'hi' },
        { role: 'assistant' as const, content: 'yo' },
      ],
      modelAlias: 'ds-chat',
      updatedAt: 1,
    };
    await store.save(data);
    expect(await store.load('telegram:42')).toEqual(data);
  });

  it('不存在的 key 返回 undefined', async () => {
    const store = new FileSessionStore(newDir(), silentLog);
    expect(await store.load('nope')).toBeUndefined();
  });

  it('损坏的 JSON 按空会话处理并记日志', async () => {
    const dir = newDir();
    const store = new FileSessionStore(dir, silentLog);
    writeFileSync(join(dir, 'telegram%3A42.json'), '{broken', 'utf8');
    expect(await store.load('telegram:42')).toBeUndefined();
  });

  it('delete 删除文件', async () => {
    const store = new FileSessionStore(newDir(), silentLog);
    await store.save({ key: 'feishu:oc_x', history: [], updatedAt: 1 });
    await store.delete('feishu:oc_x');
    expect(await store.load('feishu:oc_x')).toBeUndefined();
  });
});
