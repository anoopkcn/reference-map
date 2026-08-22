import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DETAIL_RANK, type DetailLevel, type ListKind, type Lookup, type Paper, type PaperId } from '../types';
import { mergePaper } from './normalize';

export interface CachedList {
  ids: PaperId[];
  /** Limit used when fetching; a cached list is reusable for any limit ≤ this unless it was exhaustive. */
  limit: number;
  /** True when the list is complete (S2 returned no `next`). */
  complete: boolean;
  fetchedAt: number;
}

export interface CachedLookup {
  /** null = negative cache (404). */
  paperId: PaperId | null;
  fetchedAt: number;
}

export interface CacheAdapter {
  getPaper(id: PaperId): Promise<Paper | undefined>;
  getPapers(ids: readonly PaperId[]): Promise<Map<PaperId, Paper>>;
  putPapers(papers: readonly Paper[]): Promise<void>;
  getList(id: PaperId, kind: ListKind): Promise<CachedList | undefined>;
  putList(id: PaperId, kind: ListKind, list: CachedList): Promise<void>;
  getLookup(lookup: Lookup): Promise<CachedLookup | undefined>;
  putLookup(lookup: Lookup, v: CachedLookup): Promise<void>;
  clear(): Promise<void>;
}

const DAY = 86_400_000;
export const TTL = {
  paper: 7 * DAY,
  list: 3 * DAY,
  lookup: 30 * DAY,
  negativeLookup: 3_600_000,
} as const;

export function isFresh(fetchedAt: number, ttl: number, now = Date.now()): boolean {
  return now - fetchedAt < ttl;
}

export function paperSatisfies(p: Paper | undefined, level: DetailLevel, now = Date.now()): p is Paper {
  return !!p && DETAIL_RANK[p.detailLevel] >= DETAIL_RANK[level] && isFresh(p.fetchedAt, TTL.paper, now);
}

export function listKey(id: PaperId, kind: ListKind): string {
  return `${id}:${kind}`;
}

/** In-memory adapter (tests, and fallback when IndexedDB is unavailable). */
export class MemoryCache implements CacheAdapter {
  papers = new Map<PaperId, Paper>();
  lists = new Map<string, CachedList>();
  lookups = new Map<string, CachedLookup>();

  async getPaper(id: PaperId) {
    return this.papers.get(id);
  }
  async getPapers(ids: readonly PaperId[]) {
    const out = new Map<PaperId, Paper>();
    for (const id of ids) {
      const p = this.papers.get(id);
      if (p) out.set(id, p);
    }
    return out;
  }
  async putPapers(papers: readonly Paper[]) {
    for (const p of papers) this.papers.set(p.paperId, mergePaper(this.papers.get(p.paperId), p));
  }
  async getList(id: PaperId, kind: ListKind) {
    return this.lists.get(listKey(id, kind));
  }
  async putList(id: PaperId, kind: ListKind, list: CachedList) {
    this.lists.set(listKey(id, kind), list);
  }
  async getLookup(lookup: Lookup) {
    return this.lookups.get(lookup.toLowerCase());
  }
  async putLookup(lookup: Lookup, v: CachedLookup) {
    this.lookups.set(lookup.toLowerCase(), v);
  }
  async clear() {
    this.papers.clear();
    this.lists.clear();
    this.lookups.clear();
  }
}

interface RefMapDB extends DBSchema {
  papers: { key: PaperId; value: Paper };
  lists: { key: string; value: CachedList & { key: string } };
  lookups: { key: string; value: CachedLookup & { key: string } };
}

const DB_NAME = 'refmap';
const DB_VERSION = 1;

/** IndexedDB adapter. All writes are best-effort; reads swallow errors and behave like misses. */
export class IdbCache implements CacheAdapter {
  private constructor(private db: IDBPDatabase<RefMapDB>) {}

  static async open(): Promise<IdbCache> {
    const db = await openDB<RefMapDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('papers')) db.createObjectStore('papers', { keyPath: 'paperId' });
        if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('lookups')) db.createObjectStore('lookups', { keyPath: 'key' });
      },
    });
    return new IdbCache(db);
  }

  async getPaper(id: PaperId) {
    try {
      return await this.db.get('papers', id);
    } catch {
      return undefined;
    }
  }
  async getPapers(ids: readonly PaperId[]) {
    const out = new Map<PaperId, Paper>();
    if (ids.length === 0) return out;
    try {
      const tx = this.db.transaction('papers');
      const rows = await Promise.all(ids.map((id) => tx.store.get(id)));
      await tx.done;
      rows.forEach((p) => {
        if (p) out.set(p.paperId, p);
      });
    } catch {
      /* miss */
    }
    return out;
  }
  async putPapers(papers: readonly Paper[]) {
    if (papers.length === 0) return;
    try {
      const tx = this.db.transaction('papers', 'readwrite');
      await Promise.all(
        papers.map(async (p) => {
          const prev = await tx.store.get(p.paperId);
          await tx.store.put(mergePaper(prev, p));
        }),
      );
      await tx.done;
    } catch {
      /* best effort */
    }
  }
  async getList(id: PaperId, kind: ListKind) {
    try {
      const row = await this.db.get('lists', listKey(id, kind));
      if (!row) return undefined;
      const { key: _k, ...rest } = row;
      return rest;
    } catch {
      return undefined;
    }
  }
  async putList(id: PaperId, kind: ListKind, list: CachedList) {
    try {
      await this.db.put('lists', { ...list, key: listKey(id, kind) });
    } catch {
      /* best effort */
    }
  }
  async getLookup(lookup: Lookup) {
    try {
      const row = await this.db.get('lookups', lookup.toLowerCase());
      if (!row) return undefined;
      const { key: _k, ...rest } = row;
      return rest;
    } catch {
      return undefined;
    }
  }
  async putLookup(lookup: Lookup, v: CachedLookup) {
    try {
      await this.db.put('lookups', { ...v, key: lookup.toLowerCase() });
    } catch {
      /* best effort */
    }
  }
  async clear() {
    try {
      await Promise.all([this.db.clear('papers'), this.db.clear('lists'), this.db.clear('lookups')]);
    } catch {
      /* best effort */
    }
  }
}

/** IndexedDB when available, otherwise memory. */
export async function createCache(): Promise<CacheAdapter> {
  if (typeof indexedDB === 'undefined') return new MemoryCache();
  try {
    return await IdbCache.open();
  } catch {
    return new MemoryCache();
  }
}
