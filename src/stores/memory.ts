import type { SessionData, SessionStore } from './types';

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionData>();

  async load(key: string): Promise<SessionData | undefined> {
    return this.map.get(key);
  }

  async save(session: SessionData): Promise<void> {
    this.map.set(session.key, session);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
