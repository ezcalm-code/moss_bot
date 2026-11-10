import { newNoteId, NotesStore, type NoteItem } from './store';

/** 笔记服务：按用户隔离的加密笔记 */
export class NotesService {
  constructor(private readonly store: NotesStore) {}

  add(userId: string, text: string): NoteItem {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('笔记内容不能为空');
    const data = this.store.load();
    const item: NoteItem = {
      id: newNoteId(),
      text: trimmed,
      createdAt: Date.now(),
    };
    data[userId] = [...(data[userId] ?? []), item];
    this.store.save(data);
    return item;
  }

  list(userId: string): NoteItem[] {
    return (this.store.load()[userId] ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(userId: string, id: string): boolean {
    const data = this.store.load();
    const items = data[userId] ?? [];
    const next = items.filter((n) => n.id !== id);
    if (next.length === items.length) return false;
    data[userId] = next;
    this.store.save(data);
    return true;
  }
}
