import type { ChatMessage } from '../llm/types';

export interface SessionData {
  key: string;
  /** 仅 user/assistant 轮次，不含 system */
  history: ChatMessage[];
  /** 会话级模型覆盖（/model 设置） */
  modelAlias?: string;
  updatedAt: number;
}

export interface SessionStore {
  load(key: string): Promise<SessionData | undefined>;
  save(session: SessionData): Promise<void>;
  delete(key: string): Promise<void>;
}

export function sessionKey(platform: string, chatId: string): string {
  return `${platform}:${chatId}`;
}
