import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface NoteItem {
  /** 短 id（8 位） */
  id: string;
  text: string;
  createdAt: number;
}

/** userId = `${platform}:${senderId}`，笔记按用户隔离 */
export type NotesData = Record<string, NoteItem[]>;

const SALT = 'moss-bots/notes/v1';
const KEY_LEN = 32;

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, KEY_LEN);
}

/**
 * 笔记持久化：整体 AES-256-GCM 加密落盘（防文件被拷走裸奔）。
 * 设计边界：防「仓库/备份泄露」；部署机被入侵连 .env 一起读走则无解。
 * key 不对时 decipher.final 抛错——调用方按「解密失败」处理，绝不静默降级明文。
 */
export class NotesStore {
  private readonly key: Buffer;

  constructor(
    private readonly path: string,
    passphrase: string,
  ) {
    this.key = deriveKey(passphrase);
  }

  load(): NotesData {
    if (!existsSync(this.path)) return {};
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(raw.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plain) as NotesData;
  }

  save(data: NotesData): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final(),
    ]);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      }),
      'utf8',
    );
  }
}

export function newNoteId(): string {
  return Math.random().toString(36).slice(2, 8);
}
