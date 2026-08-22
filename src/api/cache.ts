import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { DETAIL_RANK, type DetailLevel, type ListKind, type Lookup, type Paper, type PaperId, type ProviderId } from '../types';
import { mergePaper } from './normalize';

export interface CachedList {
  ids: PaperId[];
  /** Limit used when fetching; a cached list is reusable for any limit ≤ this unless it was exhaustive. */
  limit: number;
  /** True when the list is complete (provider returned no more pages). */
  complete: boolean;
  fetchedAt: number;
  /** Provider that supplied the list. */
  provider: ProviderId;
  /** Total reported by the provider, when known. */
  total?: number | null;
}

export interface CachedLookup {
  /** null = negative cache (not found anywhere). */
  paperId: PaperId | null;
  fetchedAt: number;
}

export interface CacheAdapter {
  getPaper(id: PaperId): Promise<Paper | undefined>;
  getPapers(ids: readonly PaperId[]): Promise<Map<PaperId, Paper>>;
  putPapers(papers: readonly Paper[]): Promise<void>;
  /** Without `provider`: the freshest list from any provider. */
  getList(id: PaperId, kind: ListKind, provider?: ProviderId): Promise<CachedList | undefined>;
  putList(id: PaperId, kind: ListKind, list: CachedList): Promise<void>;
  getLookup(lookup: Lookup): Promise<CachedLookup | undefined>;
  getLookups(lookups: readonly Lookup[]): Promise<Map<Lookup, CachedLookup>>;
  putLookup(lookup: Lookup, v: CachedLookup): Promise<void>;
  putLookups(entries: readonly (readonly [Lookup, CachedLookup])[]): Promise<void>;
  clear(): Promise<void>;
}

const DAY = 86_400_000;
export const TTL = {
  paper: 7 * DAY,
  list: 3 * DAY,
  /** Positive aliases are facts; only negatives expire. */
  negativeLookup: 3_600_000,
} as const;

export const PROVIDERS: readonly ProviderId[] = ['s2', 'openalex'];

export function isFresh(fetchedAt: number, ttl: number, now = Date.now()): boolean {
  return now - fetchedAt < ttl;
}

export function paperSatisfies(p: Paper | undefined, level: DetailLevel, now = Date.now()): p is Paper {
  return !!p && DETAIL_RANK[p.detailLevel] >= DETAIL_RANK[level] && isFresh(p.fetchedAt, TTL.paper, now);
}

export function listKey(id: PaperId, kind: ListKind, provider: ProviderId): string {
  return `${id}:${kind}:${provider}`;
}

function freshest(lists: (CachedList | undefined)[]): CachedList | undefined {
  let best: CachedList | undefined;
  for (const l of lists) if (l && (!best || l.fetchedAt > best.fetchedAt)) best = l;
  return best;
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
  async getList(id: PaperId, kind: ListKind, provider?: ProviderId) {
    if (provider) return this.lists.get(listKey(id, kind, provider));
    return freshest(PROVIDERS.map((pr) => this.lists.get(listKey(id, kind, pr))));
  }
  async putList(id: PaperId, kind: ListKind, list: CachedList) {
    const key = listKey(id, kind, list.provider);
    this.lists.set(key, preferList(this.lists.get(key), list));
  }
  async getLookup(lookup: Lookup) {
    return this.lookups.get(lookup.toLowerCase());
  }
  async getLookups(lookups: readonly Lookup[]) {
    const out = new Map<Lookup, CachedLookup>();
    for (const l of lookups) {
      const v = this.lookups.get(l.toLowerCase());
      if (v) out.set(l, v);
    }
    return out;
  }
  async putLookup(lookup: Lookup, v: CachedLookup) {
    this.lookups.set(lookup.toLowerCase(), v);
  }
  async putLookups(entries: readonly (readonly [Lookup, CachedLookup])[]) {
    for (const [lookup, v] of entries) this.lookups.set(lookup.toLowerCase(), v);
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
/** v2: canonical (provider-neutral) paper ids and provider-keyed lists — older data is wiped on upgrade. */
const DB_VERSION = 2;

/** IndexedDB adapter. All writes are best-effort; reads swallow errors and behave like misses. */
export class IdbCache implements CacheAdapter {
  private constructor(private db: IDBPDatabase<RefMapDB>) {}

  static async open(): Promise<IdbCache> {
    const db = await openDB<RefMapDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion > 0 && oldVersion < 2) {
          for (const name of ['papers', 'lists', 'lookups'] as const) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
        }
        if (!db.objectStoreNames.contains('papers')) db.createObjectStore('papers', { keyPath: 'paperId' });
        if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('lookups')) db.createObjectStore('lookups', { keyPath: 'key' });
      },
      // Another tab wants to upgrade: release our connection (reads/writes then degrade to misses until reload).
      blocking() {
        db.close();
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
  async getList(id: PaperId, kind: ListKind, provider?: ProviderId) {
    try {
      const keys = provider ? [listKey(id, kind, provider)] : PROVIDERS.map((pr) => listKey(id, kind, pr));
      const tx = this.db.transaction('lists');
      const rows = await Promise.all(keys.map((k) => tx.store.get(k)));
      await tx.done;
      return freshest(rows.map((row) => (row ? stripKey(row) : undefined)));
    } catch {
      return undefined;
    }
  }
  async putList(id: PaperId, kind: ListKind, list: CachedList) {
    try {
      const key = listKey(id, kind, list.provider);
      const tx = this.db.transaction('lists', 'readwrite');
      const previous = await tx.store.get(key);
      const preferred = preferList(previous ? stripKey(previous) : undefined, list);
      await tx.store.put({ ...preferred, key });
      await tx.done;
    } catch {
      /* best effort */
    }
  }
  async getLookup(lookup: Lookup) {
    try {
      const row = await this.db.get('lookups', lookup.toLowerCase());
      return row ? stripKey(row) : undefined;
    } catch {
      return undefined;
    }
  }
  async getLookups(lookups: readonly Lookup[]) {
    const out = new Map<Lookup, CachedLookup>();
    if (lookups.length === 0) return out;
    try {
      const tx = this.db.transaction('lookups');
      const rows = await Promise.all(lookups.map((l) => tx.store.get(l.toLowerCase())));
      await tx.done;
      rows.forEach((row, i) => {
        if (row) out.set(lookups[i]!, stripKey(row));
      });
    } catch {
      /* miss */
    }
    return out;
  }
  async putLookup(lookup: Lookup, v: CachedLookup) {
    try {
      await this.db.put('lookups', { ...v, key: lookup.toLowerCase() });
    } catch {
      /* best effort */
    }
  }
  async putLookups(entries: readonly (readonly [Lookup, CachedLookup])[]) {
    if (entries.length === 0) return;
    try {
      const tx = this.db.transaction('lookups', 'readwrite');
      await Promise.all(entries.map(([lookup, v]) => tx.store.put({ ...v, key: lookup.toLowerCase() })));
      await tx.done;
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

function stripKey<T extends { key: string }>(row: T): Omit<T, 'key'> {
  const { key: _k, ...rest } = row;
  return rest;
}

/** IndexedDB when available, otherwise memory. Never blocks start-up for long (e.g. an upgrade held by an old tab). */
export async function createCache(timeoutMs = 3000, fallback: CacheAdapter = new MemoryCache()): Promise<CacheAdapter> {
  if (typeof indexedDB === 'undefined') return fallback;
  try {
    const opened = IdbCache.open();
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), timeoutMs));
    const db = await Promise.race([opened, timeout]);
    if (db) return db;
    // Upgrade blocked or slow: start with memory; swap in IndexedDB later if it becomes available.
    void opened.then((idb) => onIdbLate?.(idb)).catch(() => {});
    return fallback;
  } catch {
    return fallback;
  }
}

/** Never replace a complete list or a larger prefix with a smaller concurrent response. */
function preferList(previous: CachedList | undefined, next: CachedList): CachedList {
  if (!previous) return next;
  if (previous.complete !== next.complete) return previous.complete ? previous : next;
  if (previous.limit !== next.limit) return previous.limit > next.limit ? previous : next;
  return previous.fetchedAt > next.fetchedAt ? previous : next;
}

/** Set by main.tsx to adopt a late-opening IndexedDB cache. */
export let onIdbLate: ((c: CacheAdapter) => void) | null = null;
export function setOnIdbLate(fn: (c: CacheAdapter) => void): void {
  onIdbLate = fn;
}
