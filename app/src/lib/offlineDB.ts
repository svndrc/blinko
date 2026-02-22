import Dexie, { type Table } from 'dexie';

export interface CachedNote {
  id: number;
  type: number;
  content: string;
  isArchived: boolean;
  isRecycle: boolean;
  isShare: boolean;
  isTop: boolean;
  isReviewed: boolean;
  createdAt: Date;
  updatedAt: Date;
  accountId?: number;
  metadata?: any;
  attachments: any[];
  tags: any[];
  references: any[];
  referencedBy?: any[];
  comments?: any;
  _count?: { comments: number; histories: number };
  account?: any;
  // Offline-specific fields
  _dirty: boolean;
  _syncAction?: 'create' | 'update';
  _isOfflineCreated: boolean;
}

export interface CachedTag {
  id: number;
  name: string;
  icon: string;
  parent: number;
  sortOrder: number;
}

class BlinkoOfflineDB extends Dexie {
  notes!: Table<CachedNote, number>;
  tags!: Table<CachedTag, number>;

  constructor() {
    super('blinko-offline');
    this.version(1).stores({
      notes: 'id, type, isArchived, isRecycle, updatedAt',
      tags: 'id, name, parent'
    });
  }
}

export const offlineDB = new BlinkoOfflineDB();

export async function cacheNotes(notes: any[]): Promise<void> {
  await offlineDB.transaction('rw', offlineDB.notes, async () => {
    for (const note of notes) {
      const existing = await offlineDB.notes.get(note.id);
      if (existing && existing._dirty) continue; // Don't overwrite locally modified notes
      await offlineDB.notes.put({
        ...note,
        createdAt: new Date(note.createdAt),
        updatedAt: new Date(note.updatedAt),
        _dirty: false,
        _syncAction: undefined,
        _isOfflineCreated: false,
      });
    }
  });
}

export async function getCachedNotes(params: {
  type?: number;
  isArchived?: boolean | null;
  isRecycle?: boolean;
  searchText?: string;
  page: number;
  size: number;
}): Promise<CachedNote[]> {
  const allNotes = await offlineDB.notes.orderBy('updatedAt').reverse().toArray();

  const filtered = allNotes.filter(note => {
    if (params.type !== undefined && params.type !== -1 && note.type !== params.type) return false;
    if (params.isArchived !== undefined && params.isArchived !== null && note.isArchived !== params.isArchived) return false;
    if (params.isRecycle !== undefined && note.isRecycle !== params.isRecycle) return false;
    if (params.searchText && !note.content.toLowerCase().includes(params.searchText.toLowerCase())) return false;
    return true;
  });

  const offset = (params.page - 1) * params.size;
  return filtered.slice(offset, offset + params.size);
}

export async function getCachedNote(id: number): Promise<CachedNote | undefined> {
  return await offlineDB.notes.get(id);
}

export async function saveNoteLocally(note: CachedNote): Promise<void> {
  await offlineDB.notes.put(note);
}

export async function getDirtyNotes(): Promise<CachedNote[]> {
  return (await offlineDB.notes.toArray()).filter(n => n._dirty);
}

export async function markSynced(tempId: number, serverNote: any): Promise<void> {
  await offlineDB.transaction('rw', offlineDB.notes, async () => {
    if (tempId !== serverNote.id) {
      await offlineDB.notes.delete(tempId);
    }
    await offlineDB.notes.put({
      ...serverNote,
      createdAt: new Date(serverNote.createdAt),
      updatedAt: new Date(serverNote.updatedAt),
      _dirty: false,
      _syncAction: undefined,
      _isOfflineCreated: false,
    });
  });
}

export async function cacheTags(tags: any[]): Promise<void> {
  await offlineDB.tags.bulkPut(tags);
}

export async function getCachedTags(): Promise<CachedTag[]> {
  return await offlineDB.tags.toArray();
}

export async function clearOfflineData(): Promise<void> {
  await offlineDB.notes.clear();
  await offlineDB.tags.clear();
}
