import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 记忆 key：platform:chatId:senderId（群聊按说话人各存一份） */
export type MemoryKey = string;

/**
 * 每个用户一份 Markdown 画像（自由文本，人可直接查看/手改）。
 * 读写失败静默降级为空——记忆是增强功能，绝不能因它打断聊天。
 */
export class UserMemoryStore {
  constructor(private readonly dir: string) {}

  private pathFor(key: MemoryKey): string {
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
  }

  async load(key: MemoryKey): Promise<string> {
    const p = this.pathFor(key);
    try {
      if (!existsSync(p)) return '';
      return readFileSync(p, 'utf8').trim();
    } catch {
      return '';
    }
  }

  async save(key: MemoryKey, content: string): Promise<void> {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.pathFor(key), `${content.trim()}\n`, 'utf8');
    } catch {
      // best-effort
    }
  }

  async clear(key: MemoryKey): Promise<void> {
    const p = this.pathFor(key);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

export function memoryKeyOf(platform: string, chatId: string, senderId: string): MemoryKey {
  return `${platform}:${chatId}:${senderId}`;
}

/**
 * 生成提取 prompt：让模型把「现有记忆」与「最新一轮对话」合并成新画像。
 * 返回 undefined 表示无需更新（模型判定无新信息）。
 */
export function buildExtractPrompt(existing: string, transcript: string): string {
  return [
    '你是记忆管理器。根据「现有记忆」和「最新对话」，输出合并后的新记忆。',
    '',
    '值得记（标准：一周后仍有用）：',
    '- 身份类：名字/称呼、城市、职业或学业',
    '- 长期偏好：喜欢/讨厌什么、称呼偏好',
    '- 进行中的大事：项目、考试、搬家、养宠物',
    '- 身边重要的人：名字与关系',
    '- 用户明确要求记住的内容（最高优先级）',
    '',
    '不要记：',
    '- 一次性事件与当下情绪的细节',
    '- 敏感信息：密码、证件号、详细住址、支付信息——即使提到了也不记',
    '- 无信息量的寒暄',
    '',
    '输出规则：',
    '- 用 Markdown 列表输出合并后的完整新记忆，每条一行（- 开头）',
    '- 与现有记忆冲突时以最新对话为准；没有新信息就原样输出现有记忆，不要加任何解释',
    '- 总长超过 500 字时自行精简合并最重要的条目',
    '',
    existing ? `现有记忆：\n${existing}` : '现有记忆：（空）',
    '',
    '最新对话：',
    transcript,
  ].join('\n');
}
