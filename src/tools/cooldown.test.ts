import { describe, expect, it } from 'vitest';
import { ChatCooldown } from './cooldown';

describe('ChatCooldown', () => {
  it('mark 后同 key 冷却命中（返回剩余秒），跨 turnId 放行', () => {
    let t = 0;
    const cd = new ChatCooldown(300_000, () => t);
    cd.mark('tg:c1', 'turn-a', t);
    expect(cd.check('tg:c1', 'turn-b', t + 1000)).toBe(299); // 跨轮冷却
    expect(cd.check('tg:c1', 'turn-a', t + 1000)).toBeUndefined(); // 同轮放行
    expect(cd.check('tg:c1', 'turn-b', t + 299_000)).toBe(1);
    expect(cd.check('tg:c1', 'turn-b', t + 300_000)).toBeUndefined(); // 已过期
  });

  it('release 回滚后立即可用', () => {
    let t = 0;
    const cd = new ChatCooldown(300_000, () => t);
    cd.mark('tg:c1', 'turn-a', t);
    cd.release('tg:c1');
    expect(cd.check('tg:c1', 'turn-b', t + 1)).toBeUndefined();
  });

  it('不同 key 互不影响', () => {
    let t = 0;
    const cd = new ChatCooldown(300_000, () => t);
    cd.mark('tg:c1', 'turn-a', t);
    expect(cd.check('tg:c2', 'turn-b', t + 1)).toBeUndefined();
    expect(cd.check('tg:c1', 'turn-b', t + 1)).not.toBeUndefined();
  });
});
