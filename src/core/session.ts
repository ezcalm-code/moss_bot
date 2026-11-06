import type { PlatformId } from '../adapters/types';
import type { ChatMessage } from '../llm/types';
import type { SessionData, SessionStore } from '../stores/types';
import { sessionKey } from '../stores/types';

export class SessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly maxHistory: number,
  ) {}

  /** 超出上限时裁掉最旧的消息（简单条数封顶，不做 token 计数） */
  trim(history: ChatMessage[]): ChatMessage[] {
    if (history.length <= this.maxHistory) return history;
    return history.slice(history.length - this.maxHistory);
  }

  async get(platform: PlatformId, chatId: string): Promise<SessionData> {
    const key = sessionKey(platform, chatId);
    const existing = await this.store.load(key);
    return existing ?? { key, history: [], updatedAt: Date.now() };
  }

  async appendTurn(session: SessionData, user: ChatMessage, assistant: ChatMessage): Promise<void> {
    session.history = this.trim([...session.history, user, assistant]);
    session.updatedAt = Date.now();
    await this.store.save(session);
  }

  async setModelAlias(session: SessionData, alias: string | undefined): Promise<void> {
    session.modelAlias = alias;
    session.updatedAt = Date.now();
    await this.store.save(session);
  }

  async reset(platform: PlatformId, chatId: string): Promise<void> {
    await this.store.delete(sessionKey(platform, chatId));
  }
}
