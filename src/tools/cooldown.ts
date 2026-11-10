/** 按会话冷却：跨轮冷却 + 同轮（turnId 相同）放行 + 失败回滚。web_search 与生图共用 */
export class ChatCooldown {
  private readonly lastUsed = new Map<string, { t: number; turnId: string }>();

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 冷却命中返回剩余秒数（不允许）；同轮放行与已过期返回 undefined（允许） */
  check(key: string, turnId: string, nowMs = this.now()): number | undefined {
    this.sweepExpired(nowMs);
    const last = this.lastUsed.get(key);
    if (last === undefined || last.turnId === turnId || nowMs - last.t >= this.cooldownMs) {
      return undefined;
    }
    return Math.ceil((this.cooldownMs - (nowMs - last.t)) / 1000);
  }

  /** 标记某会话已使用（烧窗） */
  mark(key: string, turnId: string, nowMs = this.now()): void {
    this.lastUsed.set(key, { t: nowMs, turnId });
  }

  /** 回滚（连接层失败未计费场景） */
  release(key: string): void {
    this.lastUsed.delete(key);
  }

  private sweepExpired(nowMs: number): void {
    for (const [k, v] of this.lastUsed) {
      if (nowMs - v.t >= this.cooldownMs) this.lastUsed.delete(k);
    }
  }
}
