import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExtractPrompt, memoryKeyOf, UserMemoryStore } from './store';

const dirs: string[] = [];

function newStore(): UserMemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'moss-memory-'));
  dirs.push(dir);
  return new UserMemoryStore(dir);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('UserMemoryStore', () => {
  it('save/load 往返', async () => {
    const store = newStore();
    await store.save('telegram:1:u1', '- 用户叫小明');
    expect(await store.load('telegram:1:u1')).toBe('- 用户叫小明');
  });

  it('key 中的冒号被安全编码', async () => {
    const store = newStore();
    await store.save('telegram:1:u1', 'x');
    const key = memoryKeyOf('telegram', '1', 'u1');
    expect(key).toBe('telegram:1:u1');
    expect(await store.load(key)).toBe('x');
  });

  it('未写入的 key 返回空串', async () => {
    const store = newStore();
    expect(await store.load('nobody')).toBe('');
  });

  it('clear 删除画像', async () => {
    const store = newStore();
    await store.save('a', 'x');
    await store.clear('a');
    expect(await store.load('a')).toBe('');
  });
});

describe('buildExtractPrompt', () => {
  it('包含现有记忆与对话内容', () => {
    const p = buildExtractPrompt('- 用户叫小明', '用户：我喜欢吃辣');
    expect(p).toContain('- 用户叫小明');
    expect(p).toContain('用户：我喜欢吃辣');
    expect(p).toContain('敏感信息');
  });

  it('无现有记忆时标注为空', () => {
    expect(buildExtractPrompt('', 'hi')).toContain('（空）');
  });
});
