"use client";
import { useEffect } from 'react';
import { PromisePageState, PromiseState } from './standard/PromiseState';
import { Store } from './standard/base';
import { helper } from '@/lib/helper';
import { ToastPlugin } from './module/Toast/Toast';
import { RootStore } from './root';
import { eventBus } from '@/lib/event';
import { StorageListState } from './standard/StorageListState';
import i18n from '@/lib/i18n';
import { api } from '@/lib/trpc';
import { Attachment, NoteType, type Note } from '@shared/lib/types';
import { ARCHIVE_BLINKO_TASK_NAME, DBBAK_TASK_NAME } from '@shared/lib/sharedConstant';
import { makeAutoObservable } from 'mobx';
import { UserStore } from './user';
import { BaseStore } from './baseStore';
import { StorageState } from './standard/StorageState';
import { useSearchParams, useLocation } from 'react-router-dom';
import {
  cacheNotes, getCachedNotes, getCachedNote,
  saveNoteLocally, getDirtyNotes, markSynced,
  cacheTags, getCachedTags, clearOfflineData,
  type CachedNote
} from '@/lib/offlineDB';

type filterType = {
  label: string;
  sortBy: string;
  direction: string;
}

// Interface for note upsert parameters
interface UpsertNoteParams {
  /** Note content */
  content?: string | null;
  /** Whether the note is archived */
  isArchived?: boolean;
  /** Whether the note is in recycle bin */
  isRecycle?: boolean;
  /** Note type */
  type?: NoteType;
  /** Note ID */
  id?: number;
  /** List of attachments */
  attachments?: Attachment[];
  /** Whether to refresh the list after operation */
  refresh?: boolean;
  /** Whether the note is pinned to top */
  isTop?: boolean;
  /** Whether the note is publicly shared */
  isShare?: boolean;
  /** Whether to show toast notification */
  showToast?: boolean;
  /** List of referenced note IDs */
  references?: number[];
  /** Creation time */
  createdAt?: Date;
  /** Last update time */
  updatedAt?: Date;
  /** Metadata */
  metadata?: any;
}

export class BlinkoStore implements Store {
  sid = 'BlinkoStore';
  noteContent = '';
  createContentStorage = new StorageState<{ content: string }>({
    key: 'createModeNote',
    default: { content: '' }
  });
  createAttachmentsStorage = new StorageListState<{ name: string, path: string, type: string, size: number }>({
    key: 'createModeAttachments',
  });
  editContentStorage = new StorageListState<{ content: string, id: number }>({
    key: 'editModeNotes'
  });
  editAttachmentsStorage = new StorageListState<{ name: string, path: string, type: string, size: number, id: number }>({
    key: 'editModeAttachments'
  });

  searchText: string = '';
  isCreateMode: boolean = true
  curSelectedNote: Note | null = null;
  curMultiSelectIds: number[] = [];
  isMultiSelectMode: boolean = false;
  fullscreenEditorNoteId: number | null = null;
  forceQuery: number = 0;
  allTagRouter = {
    title: 'total',
    href: '/?path=all',
    icon: ''
  }
  noteListFilterConfig = {
    isArchived: false as boolean | null,
    isRecycle: false,
    isShare: null as boolean | null,
    type: 0,
    tagId: null as number | null,
    withoutTag: false,
    withFile: false,
    withLink: false,
    isUseAiQuery: false,
    startDate: null as Date | null,
    endDate: null as Date | null,
    hasTodo: false
  }
  noteTypeDefault: NoteType = NoteType.BLINKO
  currentCommonFilter: filterType | null = null
  updateTicker = 0
  fullNoteList: Note[] = []

  // For global search
  globalSearchTerm!: '';
  // Will be set to true when the global search modal is opened
  isGlobalSearchOpen!: false;
  // For search results presentation
  searchResults = {
    notes: [],
    resources: [],
    settings: []
  };

  private _isSyncing = false;

  get isOnline(): boolean {
    return RootStore.Get(BaseStore).isOnline;
  }

  private async getFilteredNotes(params: {
    page: number;
    size: number;
    filterConfig: any;
  }) {
    const { page, size, filterConfig } = params;

    if (this.isOnline) {
      const queryParams = {
        ...this.noteListFilterConfig,
        ...filterConfig,
        searchText: this.searchText,
        page,
        size
      };
      const notes = await api.notes.list.mutate(queryParams);
      // Cache fetched notes to IndexedDB for offline access
      cacheNotes(notes).catch(err => console.warn('Failed to cache notes:', err));
      return notes.map(i => ({ ...i, isExpand: false }));
    } else {
      // Offline: read from IndexedDB cache
      const cachedNotes = await getCachedNotes({
        type: filterConfig.type,
        isArchived: filterConfig.isArchived,
        isRecycle: filterConfig.isRecycle,
        searchText: this.searchText,
        page,
        size,
      });
      return (cachedNotes as unknown as Note[]).map(i => ({ ...i, isExpand: false }));
    }
  }

  upsertNote = new PromiseState({
    eventKey: 'upsertNote',
    function: async (params: UpsertNoteParams) => {
      console.log("upsertNote", params)
      const {
        content = null,
        isArchived,
        isRecycle,
        type,
        id,
        attachments = [],
        refresh = true,
        isTop,
        isShare,
        showToast = true,
        references = [],
        createdAt: inputCreatedAt,
        updatedAt: inputUpdatedAt,
        metadata
      } = params;

      if (!this.isOnline && !id) {
        const now = new Date();
        const tempId = now.getTime();
        const offlineNote: CachedNote = {
          id: tempId,
          content: content || '',
          type: type ?? NoteType.BLINKO,
          isArchived: !!isArchived,
          isRecycle: !!isRecycle,
          isShare: !!isShare,
          isTop: !!isTop,
          isReviewed: false,
          attachments: attachments || [],
          references: references.map(refId => ({ toNoteId: refId })),
          createdAt: now,
          updatedAt: now,
          tags: [],
          metadata: metadata || {},
          _dirty: true,
          _syncAction: 'create',
          _isOfflineCreated: true,
        };
        await saveNoteLocally(offlineNote);
        showToast && RootStore.Get(ToastPlugin).success(i18n.t("create-successfully") + '-' + i18n.t("offline-status"));
        refresh && this.updateTicker++;
        return offlineNote as unknown as Note;
      }

      // Offline edit of existing note
      if (!this.isOnline && id) {
        const existingNote = await getCachedNote(id);
        if (existingNote) {
          const updatedNote: CachedNote = {
            ...existingNote,
            content: content !== null && content !== undefined ? content : existingNote.content,
            type: type !== undefined ? type : existingNote.type,
            isArchived: isArchived !== undefined ? !!isArchived : existingNote.isArchived,
            isRecycle: isRecycle !== undefined ? !!isRecycle : existingNote.isRecycle,
            isTop: isTop !== undefined ? !!isTop : existingNote.isTop,
            isShare: isShare !== undefined ? !!isShare : existingNote.isShare,
            updatedAt: new Date(),
            metadata: metadata !== undefined ? metadata : existingNote.metadata,
            _dirty: true,
            _syncAction: existingNote._isOfflineCreated ? 'create' : 'update',
            _isOfflineCreated: existingNote._isOfflineCreated,
          };
          await saveNoteLocally(updatedNote);
          showToast && RootStore.Get(ToastPlugin).success(i18n.t("update-successfully") + '-' + i18n.t("offline-status"));
          refresh && this.updateTicker++;
          return updatedNote as unknown as Note;
        } else {
          // Note not in offline cache - cannot edit
          RootStore.Get(ToastPlugin).error(i18n.t("offline-status") + ': ' + i18n.t("operation-failed"));
          return undefined;
        }
      }

      const res = await api.notes.upsert.mutate({
        content,
        type,
        isArchived,
        isRecycle,
        id,
        attachments,
        isTop,
        isShare,
        references,
        createdAt: inputCreatedAt ? new Date(inputCreatedAt) : undefined,
        updatedAt: inputUpdatedAt ? new Date(inputUpdatedAt) : undefined,
        metadata
      });
      eventBus.emit('editor:clear')
      showToast && RootStore.Get(ToastPlugin).success(id ? i18n.t("update-successfully") : i18n.t("create-successfully"))
      refresh && this.updateTicker++
      return res
    }
  })

  shareNote = new PromiseState({
    function: async (params: { id: number, isCancel: boolean, password?: string, expireAt?: Date }) => {
      const res = await api.notes.shareNote.mutate(params)
      RootStore.Get(ToastPlugin).success(i18n.t("operation-success"))
      this.updateTicker++
      return res
    }
  })

  internalShareNote = new PromiseState({
    function: async (params: { id: number, accountIds: number[], isCancel: boolean }) => {
      const res = await api.notes.internalShareNote.mutate(params)
      RootStore.Get(ToastPlugin).success(i18n.t("operation-success"))
      this.updateTicker++
      return res
    }
  })

  getInternalSharedUsers = new PromiseState({
    function: async (id: number) => {
      return await api.notes.getInternalSharedUsers.mutate({ id })
    }
  })

  async syncDirtyNotes() {
    if (!this.isOnline || this._isSyncing) return;
    this._isSyncing = true;
    try {
      const dirtyNotes = await getDirtyNotes();
      for (const note of dirtyNotes) {
        try {
          if (note._syncAction === 'create') {
            const { id: tempId, _dirty, _syncAction, _isOfflineCreated, ...noteData } = note;
            const serverNote = await api.notes.upsert.mutate({
              content: noteData.content,
              type: noteData.type,
              isArchived: noteData.isArchived,
              isRecycle: noteData.isRecycle,
              isTop: noteData.isTop,
              isShare: noteData.isShare,
              attachments: noteData.attachments ?? [],
              references: noteData.references?.map((r: any) => r.toNoteId ?? r) ?? [],
              metadata: noteData.metadata,
            });
            await markSynced(tempId, serverNote);
          } else if (note._syncAction === 'update') {
            const serverNote = await api.notes.upsert.mutate({
              id: note.id,
              content: note.content,
              type: note.type,
              isArchived: note.isArchived,
              isRecycle: note.isRecycle,
              isTop: note.isTop,
              isShare: note.isShare,
              metadata: note.metadata,
            });
            await markSynced(note.id, serverNote);
          }
        } catch (error) {
          console.error('Failed to sync dirty note:', note.id, error);
        }
      }
    } finally {
      this._isSyncing = false;
    }
  }

  blinkoList = new PromisePageState({
    function: async ({ page, size }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          type: NoteType.BLINKO,
          isArchived: false,
          isRecycle: false
        },
      });
    }
  })

  noteOnlyList = new PromisePageState({
    function: async ({ page, size }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          type: NoteType.NOTE,
          isArchived: false,
          isRecycle: false
        },
      });
    }
  })

  todoList = new PromisePageState({
    function: async ({ page, size }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          type: NoteType.TODO,
          isArchived: false,
          isRecycle: false
        },
      });
    }
  })

  archivedList = new PromisePageState({
    function: async ({ page, size }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          isArchived: true,
          isRecycle: false
        },
      });
    }
  })

  trashList = new PromisePageState({
    function: async ({ page, size }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          isRecycle: true
        },
      });
    }
  })

  noteList = new PromisePageState({
    function: async ({ page, size, ...filterConfig }) => {
      return this.getFilteredNotes({
        page,
        size,
        filterConfig: {
          isArchived: false,
          ...filterConfig
        },
      });
    }
  })

  referenceSearchList = new PromisePageState({
    function: async ({ page, size, searchText }) => {
      return await api.notes.list.mutate({
        searchText
      })
    }
  })

  userList = new PromiseState({
    function: async () => {
      return await api.users.list.query()
    }
  })

  noteDetail = new PromiseState({
    function: async ({ id }) => {
      if (this.isOnline) {
        const result = await api.notes.detail.mutate({ id });
        if (result) {
          cacheNotes([result]).catch(err => console.warn('Failed to cache note detail:', err));
        }
        return result;
      } else {
        const cached = await getCachedNote(id);
        return (cached as unknown as Note) ?? null;
      }
    }
  })

  dailyReviewNoteList = new PromiseState({
    function: async () => {
      return await api.notes.dailyReviewNoteList.query()
    }
  })

  randomReviewNoteList = new PromiseState({
    function: async ({ limit = 30 }) => {
      return await api.notes.randomNoteList.query({ limit })
    }
  })

  resourceList = new PromisePageState({
    function: async ({ page, size, searchText, folder }) => {
      return await api.attachments.list.query({ page, size, searchText, folder })
    }
  })

  tagList = new PromiseState({
    function: async () => {
      let falttenTags: any[];
      if (this.isOnline) {
        falttenTags = await api.tags.list.query(undefined, { context: { skipBatch: true } });
        cacheTags(falttenTags).catch(err => console.warn('Failed to cache tags:', err));
      } else {
        falttenTags = await getCachedTags() as any;
      }
      const listTags = helper.buildHashTagTreeFromDb(falttenTags)
      let pathTags: string[] = [];
      listTags.forEach(node => {
        pathTags = pathTags.concat(helper.generateTagPaths(node));
      });
      return { falttenTags, listTags, pathTags }
    }
  })

  get showAi() {
    return true
  }

  config = new PromiseState({
    loadingLock: false,
    function: async () => {
      if (this.isOnline) {
        const res = await api.config.list.query();
        try { localStorage.setItem('blinko-cached-config', JSON.stringify(res)); } catch {}
        return res;
      } else {
        try {
          const cached = localStorage.getItem('blinko-cached-config');
          if (cached) return JSON.parse(cached);
        } catch {}
        return null;
      }
    }
  })

  task = new PromiseState({
    function: async () => {
      try {
        if (RootStore.Get(UserStore).role == 'superadmin') {
          return (await api.task.list.query()) ?? [];
        }
        return []
      } catch (error) {
        return []
      }
    }
  })

  updateDBTask = new PromiseState({
    function: async (isStart) => {
      if (isStart) {
        await api.task.upsertTask.mutate({ type: 'start', task: DBBAK_TASK_NAME })
      } else {
        await api.task.upsertTask.mutate({ type: 'stop', task: DBBAK_TASK_NAME })
      }
      await this.task.call()
    }
  })
  updateArchiveTask = new PromiseState({
    function: async (isStart) => {
      if (isStart) {
        await api.task.upsertTask.mutate({ type: 'start', task: ARCHIVE_BLINKO_TASK_NAME })
      } else {
        await api.task.upsertTask.mutate({ type: 'stop', task: ARCHIVE_BLINKO_TASK_NAME })
      }
      await this.task.call()
    }
  })


  get DBTask() {
    return this.task.value?.find(i => i.name == DBBAK_TASK_NAME)
  }

  get ArchiveTask() {
    return this.task.value?.find(i => i.name == ARCHIVE_BLINKO_TASK_NAME)
  }


  async onBottom() {
    const currentPath = new URLSearchParams(window.location.search).get('path');
    
    if (currentPath === 'notes') {
      await this.noteOnlyList.callNextPage({});
    } else if (currentPath === 'todo') {
      await this.todoList.callNextPage({});
    } else if (currentPath === 'archived') {
      await this.archivedList.callNextPage({});
    } else if (currentPath === 'trash') {
      await this.trashList.callNextPage({});
    } else if (currentPath === 'all') {
      this.noteList.resetAndCall({});
    } else {
      await this.blinkoList.callNextPage({});
    }
  }

  onMultiSelectNote(id: number) {
    if (this.curMultiSelectIds.includes(id)) {
      this.curMultiSelectIds = this.curMultiSelectIds.filter(item => item !== id);
    } else {
      this.curMultiSelectIds.push(id);
    }
    if (this.curMultiSelectIds.length == 0) {
      this.isMultiSelectMode = false
    }
  }

  onMultiSelectRest() {
    this.isMultiSelectMode = false
    this.curMultiSelectIds = []
    // Fix: Remove updateTicker++ to avoid unnecessary list refresh and duplicate display
    // this.updateTicker++
  }

  async migrateOfflineStorage() {
    if (localStorage.getItem('offlineNotes_migrated')) return;
    try {
      const raw = localStorage.getItem('offlineNotes');
      if (!raw) {
        localStorage.setItem('offlineNotes_migrated', '1');
        return;
      }
      const notes: any[] = JSON.parse(raw);
      for (const note of notes) {
        const exists = await getCachedNote(note.id);
        if (!exists) {
          await saveNoteLocally({
            ...note,
            isReviewed: false,
            _dirty: true,
            _syncAction: 'create',
            _isOfflineCreated: true,
          } as CachedNote);
        }
      }
      localStorage.removeItem('offlineNotes');
      localStorage.setItem('offlineNotes_migrated', '1');
    } catch (e) {
      console.warn('Failed to migrate offline storage:', e);
    }
  }

  firstLoad() {
    this.migrateOfflineStorage()
      .then(() => {
        // Sync any dirty notes from previous offline sessions
        if (this.isOnline) {
          this.syncDirtyNotes()
            .then(() => this.updateTicker++)
            .catch(err => console.warn('Failed to sync on load:', err));
        }
      })
      .catch(console.warn);
    this.tagList.call()
    this.config.call()
    this.dailyReviewNoteList.call()
    this.task.call()
  }


  async refreshData() {
    // Fix: Clear multi-select state when refreshing data to avoid stale selections
    this.curMultiSelectIds = [];
    this.isMultiSelectMode = false;

    this.tagList.call()

    const currentPath = new URLSearchParams(window.location.search).get('path');
    
    if (currentPath === 'notes') {
      this.noteOnlyList.resetAndCall({});
    } else if (currentPath === 'todo') {
      this.todoList.resetAndCall({});
    } else if (currentPath === 'archived') {
      this.archivedList.resetAndCall({});
    } else if (currentPath === 'trash') {
      this.trashList.resetAndCall({});
    } else if (currentPath === 'all') {
      this.noteList.resetAndCall({});
    } else {
      this.blinkoList.resetAndCall({});
    }
    
    this.config.call()
    this.dailyReviewNoteList.call()
  }

  private clear() {
    this.createContentStorage.clear()
    this.editContentStorage.clear()
  }

  use() {
    useEffect(() => {
      if (RootStore.Get(UserStore).id) {
        console.log('firstLoad', RootStore.Get(UserStore).id)
        this.firstLoad()
      }
    }, [RootStore.Get(UserStore).id])

    useEffect(() => {
      if (this.updateTicker == 0) return
      console.log('updateTicker', this.updateTicker)
      this.refreshData()
    }, [this.updateTicker])
  }

  useQuery() {
    const [searchParams] = useSearchParams();
    const location = useLocation();
    useEffect(() => {
      const tagId = searchParams.get('tagId');
      if (tagId && Number(tagId) === this.noteListFilterConfig.tagId) {
        return;
      }
      
      const withoutTag = searchParams.get('withoutTag');
      const withFile = searchParams.get('withFile');
      const withLink = searchParams.get('withLink');
      const searchText = searchParams.get('searchText') || this.searchText;
      const hasTodo = searchParams.get('hasTodo');
      const path = searchParams.get('path');

      this.noteListFilterConfig.type = NoteType.BLINKO
      this.noteTypeDefault = NoteType.BLINKO
      this.noteListFilterConfig.tagId = null
      this.noteListFilterConfig.isArchived = false
      this.noteListFilterConfig.withoutTag = false
      this.noteListFilterConfig.withLink = false
      this.noteListFilterConfig.withFile = false
      this.noteListFilterConfig.isRecycle = false
      this.noteListFilterConfig.startDate = null
      this.noteListFilterConfig.endDate = null
      this.noteListFilterConfig.isShare = null
      this.noteListFilterConfig.hasTodo = false

      // Fix: Clear multi-select state when switching paths to avoid stale selections
      this.curMultiSelectIds = [];
      this.isMultiSelectMode = false;

      if (path == 'notes') {
        this.noteListFilterConfig.type = NoteType.NOTE
        this.noteOnlyList.resetAndCall({});
      } else if (path == 'todo') {
        this.noteListFilterConfig.type = NoteType.TODO
        this.todoList.resetAndCall({});
      } else if (path == 'all') {
        this.noteListFilterConfig.type = -1
        this.noteList.resetAndCall({});
      } else if (path == 'archived') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isArchived = true
        this.archivedList.resetAndCall({});
      } else if (path == 'trash') {
        this.noteListFilterConfig.type = -1
        this.noteListFilterConfig.isRecycle = true
        this.trashList.resetAndCall({});
      } else {
        this.blinkoList.resetAndCall({});
      }

      if (tagId) {
        this.noteListFilterConfig.tagId = Number(tagId) as number
      }
      if (withoutTag) {
        this.noteListFilterConfig.withoutTag = true
      }
      if (withLink) {
        this.noteListFilterConfig.withLink = true
      }
      if (withFile) {
        this.noteListFilterConfig.withFile = true
      }
      if (hasTodo) {
        this.noteListFilterConfig.hasTodo = true
      }
      if (searchText) {
        this.searchText = searchText as string;
      } else {
        this.searchText = '';
      }
    }, [this.forceQuery, location.pathname, searchParams])
  }

  excludeEmbeddingTagId: number | null = null;

  setExcludeEmbeddingTagId(tagId: number | null) {
    this.excludeEmbeddingTagId = tagId;
  }

  settingsSearchText: string = '';

  constructor() {
    makeAutoObservable(this)
    eventBus.on('user:signout', () => {
      this.clear()
      clearOfflineData().catch(console.warn)
    })
    eventBus.on('app:online', () => {
      this.syncDirtyNotes()
        .then(() => this.updateTicker++)
        .catch(err => console.warn('Failed to sync on reconnect:', err));
    })
  }

  removeCreateAttachments(file: { name: string, }) {
    this.createAttachmentsStorage.removeByFind(f => f.name === file.name);
    this.updateTicker++;
  }

  updateTagFilter(tagId: number) {
    this.noteListFilterConfig.tagId = tagId;
    this.noteListFilterConfig.type = -1
    this.noteList.resetAndCall({});
  }
}
