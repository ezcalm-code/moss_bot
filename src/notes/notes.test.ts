import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createAddNoteTool } from './notes-tool';
import { NotesService } from './service';
import { NotesStore } from './store';

const log = pino({ level: 'silent' });
const tmpDirs: string[] = [];

function makeStore(passphrase = 'secret-key'): { store: NotesStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'moss-notes-'));
  tmpDirs.push(dir);
  const path = join(dir, 'notes.bin');
  return { store: new NotesStore(path, passphrase), path };
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('NotesStore', () => {
  it('写入的是密文，读回为明文（roundtrip）', () => {
    const { store, path } = makeStore();
    store.save({ 'telegram:u1': [{ id: 'abc123', text: '书房wifi密码是moss2026', createdAt: 1 }] });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('wifi'); // 明文不可见
    expect(raw).not.toContain('moss2026');
    const data = store.load();
    expect(data['telegram:u1']?.[0]?.text).toBe('书房wifi密码是moss2026');
  });

  it('key 不对时解密抛错（绝不静默降级）', () => {
    const { store, path } = makeStore('right-key');
    store.save({ 'u1': [{ id: 'n1', text: 'x', createdAt: 1 }] });
    const wrong = new NotesStore(path, 'wrong-key');
    expect(() => wrong.load()).toThrow();
  });
});

describe('NotesService', () => {
  it('add/list/remove 按用户隔离', () => {
    const svc = new NotesService(makeStore().store);
    const a = svc.add('tg:u1', '第一条');
    svc.add('tg:u1', '第二条');
    svc.add('tg:u2', '别人的');
    expect(svc.list('tg:u1').map((n) => n.text)).toEqual(['第一条', '第二条']);
    expect(svc.list('tg:u2')).toHaveLength(1);
    expect(svc.remove('tg:u2', a.id)).toBe(false); // 不能删别人的
    expect(svc.remove('tg:u1', a.id)).toBe(true);
    expect(svc.list('tg:u1')).toHaveLength(1);
  });

  it('空内容拒绝', () => {
    const svc = new NotesService(makeStore().store);
    expect(() => svc.add('u1', '   ')).toThrow(/不能为空/);
  });
});

describe('createAddNoteTool', () => {
  const ctx = {
    platform: 'telegram',
    chatId: 'c',
    senderId: 'u1',
    senderName: 'U',
    isGroup: false,
    turnId: 't',
    log,
  } as const;

  it('合法参数记笔记并返回 id', async () => {
    const svc = new NotesService(makeStore().store);
    const tool = createAddNoteTool({ service: svc });
    const out = await tool.exec({ text: '书房 wifi 密码 moss2026' }, ctx);
    expect(out).toContain('已记下');
    expect(svc.list('telegram:u1')).toHaveLength(1);
  });

  it('空参数返回错误串', async () => {
    const svc = new NotesService(makeStore().store);
    const tool = createAddNoteTool({ service: svc });
    expect(await tool.exec({}, ctx)).toContain('参数错误');
    expect(await tool.exec({ text: '  ' }, ctx)).toContain('参数错误');
  });
});
