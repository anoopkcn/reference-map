import { create } from 'zustand';
import { isFresh, paperSatisfies, TTL, type CacheAdapter } from '../api/cache';
import { describeError, isAbort, NotFoundError } from '../api/errors';
import type { QueueStatus, RequestQueue } from '../api/queue';
import { AUTH_QUEUE, UNAUTH_QUEUE } from '../api/queue';
import { PRIORITY, type S2Client } from '../api/s2';
import { mergePaper } from '../api/normalize';
import { lookupKey } from '../lib/ids';
import { DEFAULT_SETTINGS, type ListKind, type ListState, type LoadStatus, type Lookup, type Paper, type PaperId, type Seed, type Settings } from '../types';
import { GraphModel } from './graphModel';
import { sanitizeSettings, saveSettings } from './settings';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export interface SearchState {
  query: string;
  status: LoadStatus;
  ids: PaperId[];
  total: number | null;
  error?: string;
}

export interface ListsEntry {
  refs?: ListState;
  cites?: ListState;
}

export interface AppState {
  papers: Map<PaperId, Paper>;
  seeds: Seed[];
  lists: Map<PaperId, ListsEntry>;
  /** Stable instance; `graphVersion` changes whenever it mutates. */
  graph: GraphModel;
  graphVersion: number;
  expanding: Set<PaperId>;
  selectedId: PaperId | null;
  hoveredId: PaperId | null;
  search: SearchState | null;
  queue: QueueStatus;
  settings: Settings;
  toasts: Toast[];

  addSeeds(lookups: readonly Lookup[]): Promise<void>;
  removeSeed(lookup: Lookup): void;
  loadList(id: PaperId, kind: ListKind, opts?: { force?: boolean }): Promise<ListState>;
  expandNode(id: PaperId): Promise<void>;
  /** Re-fetch a seed's details and lists from the network (bypassing caches) and rebuild the map. */
  refreshSeed(lookup: Lookup): Promise<void>;
  ensureDetail(id: PaperId): Promise<Paper | undefined>;
  searchPapers(query: string): Promise<void>;
  clearSearch(): void;
  select(id: PaperId | null): void;
  hover(id: PaperId | null): void;
  setPinned(id: PaperId, pinned: boolean): void;
  unpinAll(): void;
  updateSettings(patch: Partial<Settings>): void;
  clearCache(): Promise<void>;
  pushToast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

export interface StoreDeps {
  client: S2Client;
  queue: RequestQueue;
  cache: CacheAdapter;
  settings?: Settings;
  now?: () => number;
  /** Toast auto-dismiss (ms); 0 disables. */
  toastMs?: number;
}

export type AppStore = ReturnType<typeof createAppStore>;

const SHA_RE = /^[0-9a-f]{40}$/i;
const BATCH_THRESHOLD = 3;

export function createAppStore(deps: StoreDeps) {
  const { client, queue } = deps;
  let cache = deps.cache;
  const now = deps.now ?? (() => Date.now());
  const toastMs = deps.toastMs ?? 3500;
  const listPromises = new Map<string, Promise<ListState>>();
  const expandPromises = new Map<PaperId, Promise<void>>();
  let searchCtrl: AbortController | null = null;
  let toastSeq = 0;

  const initialSettings = sanitizeSettings(deps.settings ?? DEFAULT_SETTINGS);
  queue.configure(initialSettings.apiKey ? AUTH_QUEUE : UNAUTH_QUEUE);

  const store = create<AppState>()((set, get) => {
    /** Merge papers into the store (one Map copy per batch) and persist. */
    const upsertPapers = (incoming: readonly Paper[]): void => {
      if (incoming.length === 0) return;
      const prev = get().papers;
      const next = new Map(prev);
      const changed: Paper[] = [];
      for (const p of incoming) {
        const merged = mergePaper(prev.get(p.paperId), p);
        next.set(p.paperId, merged);
        changed.push(merged);
      }
      set({ papers: next });
      void cache.putPapers(changed);
    };

    const setList = (id: PaperId, kind: ListKind, state: ListState): void => {
      const prev = get().lists;
      const next = new Map(prev);
      next.set(id, { ...(prev.get(id) ?? {}), [kind]: state });
      set({ lists: next });
    };

    const cachedListIds = (id: PaperId, kind: ListKind): readonly PaperId[] | undefined => {
      const l = get().lists.get(id)?.[kind];
      return l && l.status === 'ready' ? l.ids : undefined;
    };

    const bumpGraph = (): void => set({ graphVersion: get().graph.version });

    const setSeed = (lookup: Lookup, patch: Partial<Seed>): void => {
      set({ seeds: get().seeds.map((s) => (s.lookup === lookup ? { ...s, ...patch } : s)) });
    };

    /** Make sure every id has a Paper in the store: memory → cache → batch fetch. */
    const ensurePapers = async (ids: readonly PaperId[]): Promise<void> => {
      const missing = ids.filter((id) => !get().papers.has(id));
      if (missing.length === 0) return;
      const fromCache = await cache.getPapers(missing);
      const fresh: Paper[] = [];
      const stillMissing: PaperId[] = [];
      for (const id of missing) {
        const p = fromCache.get(id);
        if (paperSatisfies(p, 'list', now())) fresh.push(p);
        else stillMissing.push(id);
      }
      upsertPapers(fresh);
      if (stillMissing.length) {
        const fetched = await client.getBatch(stillMissing, 'list', { priority: PRIORITY.list });
        upsertPapers(fetched.filter((p): p is Paper => !!p));
      }
    };

    /** Resolve one lookup to a Paper using lookup cache → paper cache → network. */
    const resolveFromCache = async (lookup: Lookup): Promise<Paper | 'notfound' | null> => {
      const state = get();
      if (SHA_RE.test(lookup)) {
        const id = lookup.toLowerCase();
        const p = state.papers.get(id) ?? (await cache.getPaper(id));
        if (paperSatisfies(p, 'list', now())) return p;
        return null;
      }
      const cl = await cache.getLookup(lookup);
      if (!cl) return null;
      if (cl.paperId === null) return isFresh(cl.fetchedAt, TTL.negativeLookup, now()) ? 'notfound' : null;
      if (!isFresh(cl.fetchedAt, TTL.lookup, now())) return null;
      const p = state.papers.get(cl.paperId) ?? (await cache.getPaper(cl.paperId));
      return paperSatisfies(p, 'list', now()) ? p : null;
    };

    const resolveFromNetwork = async (lookup: Lookup): Promise<Paper> => {
      try {
        const p = await client.getPaper(lookup, 'full', { priority: PRIORITY.seed });
        void cache.putLookup(lookup, { paperId: p.paperId, fetchedAt: now() });
        return p;
      } catch (e) {
        if (e instanceof NotFoundError) void cache.putLookup(lookup, { paperId: null, fetchedAt: now() });
        throw e;
      }
    };

    /** Called once a seed resolved to a paper: dedupe, add to graph, auto-expand. */
    const seedReady = (lookup: Lookup, paper: Paper): void => {
      const state = get();
      const dup = state.seeds.find((s) => s.lookup !== lookup && s.paperId === paper.paperId);
      if (dup) {
        set({ seeds: state.seeds.filter((s) => s.lookup !== lookup) });
        get().pushToast('Already in the map');
        return;
      }
      setSeed(lookup, { paperId: paper.paperId, status: 'ready', error: undefined });
      state.graph.addSeed(paper.paperId, paper, get().papers);
      bumpGraph();
      if (get().settings.autoExpandSeeds) void get().expandNode(paper.paperId);
    };

    return {
      papers: new Map(),
      seeds: [],
      lists: new Map(),
      graph: new GraphModel(),
      graphVersion: 0,
      expanding: new Set(),
      selectedId: null,
      hoveredId: null,
      search: null,
      queue: queue.status(),
      settings: initialSettings,
      toasts: [],

      async addSeeds(lookups) {
        const seen = new Set(get().seeds.map((s) => lookupKey(s.lookup)));
        const fresh: Lookup[] = [];
        for (const l of lookups) {
          const k = lookupKey(l);
          if (seen.has(k)) continue;
          seen.add(k);
          fresh.push(l);
        }
        if (fresh.length === 0) return;
        set({ seeds: [...get().seeds, ...fresh.map((lookup): Seed => ({ lookup, paperId: null, status: 'resolving' }))], search: null });

        const needNetwork: Lookup[] = [];
        await Promise.all(
          fresh.map(async (lookup) => {
            try {
              const r = await resolveFromCache(lookup);
              if (r === 'notfound') setSeed(lookup, { status: 'error', error: 'Not found on Semantic Scholar' });
              else if (r) {
                upsertPapers([r]);
                seedReady(lookup, r);
              } else needNetwork.push(lookup);
            } catch {
              needNetwork.push(lookup);
            }
          }),
        );
        if (needNetwork.length === 0) return;

        const finishOne = (lookup: Lookup, p: Paper | null, err?: unknown) => {
          if (p) {
            upsertPapers([p]);
            void cache.putLookup(lookup, { paperId: p.paperId, fetchedAt: now() });
            seedReady(lookup, p);
          } else {
            if (p === null && !err) void cache.putLookup(lookup, { paperId: null, fetchedAt: now() });
            setSeed(lookup, { status: 'error', error: err ? describeError(err) : 'Not found on Semantic Scholar' });
          }
        };

        if (needNetwork.length >= BATCH_THRESHOLD) {
          try {
            const results = await client.getBatch(needNetwork, 'full', { priority: PRIORITY.batch });
            needNetwork.forEach((lookup, i) => finishOne(lookup, results[i] ?? null));
            return;
          } catch {
            /* fall through to individual requests (e.g. batch endpoint blocked) */
          }
        }
        await Promise.all(
          needNetwork.map(async (lookup) => {
            try {
              finishOne(lookup, await resolveFromNetwork(lookup));
            } catch (e) {
              finishOne(lookup, null, e);
            }
          }),
        );
      },

      removeSeed(lookup) {
        const state = get();
        const seeds = state.seeds.filter((s) => s.lookup !== lookup);
        set({ seeds });
        const seedIds = seeds.map((s) => s.paperId).filter((id): id is PaperId => !!id);
        state.graph.rebuild(seedIds, state.papers, state.settings.graphExpandLimit, cachedListIds);
        bumpGraph();
        if (state.selectedId && !state.graph.hasNode(state.selectedId)) set({ selectedId: null });
      },

      loadList(id, kind, opts = {}) {
        const key = `${id}:${kind}`;
        const existing = get().lists.get(id)?.[kind];
        if (!opts.force && existing && existing.status === 'ready') return Promise.resolve(existing);
        const inflight = listPromises.get(key);
        if (inflight) return inflight;

        const run = async (): Promise<ListState> => {
          setList(id, kind, { ids: existing?.ids ?? [], status: 'loading', total: existing?.total ?? null });
          const limit = get().settings.listLimit;
          try {
            const cached = opts.force ? undefined : await cache.getList(id, kind);
            if (cached && isFresh(cached.fetchedAt, TTL.list, now()) && (cached.complete || cached.limit >= limit)) {
              await ensurePapers(cached.ids);
              const ids = cached.ids.filter((x) => get().papers.has(x));
              const st: ListState = { ids, status: 'ready', total: listTotal(get().papers.get(id), kind, ids.length) };
              setList(id, kind, st);
              return st;
            }
            const res = await client.getList(id, kind, limit, { priority: PRIORITY.list });
            upsertPapers(res.papers);
            void cache.putList(id, kind, { ids: res.ids, limit, complete: !res.hasMore, fetchedAt: now() });
            const st: ListState = { ids: res.ids, status: 'ready', total: listTotal(get().papers.get(id), kind, res.ids.length) };
            setList(id, kind, st);
            return st;
          } catch (e) {
            const st: ListState = { ids: [], status: 'error', total: null, error: describeError(e) };
            setList(id, kind, st);
            return st;
          } finally {
            listPromises.delete(key);
          }
        };
        const p = run();
        listPromises.set(key, p);
        return p;
      },

      expandNode(id) {
        const running = expandPromises.get(id);
        if (running) return running;
        const run = async () => {
          const state = get();
          const paper = state.papers.get(id);
          if (!paper) return;
          // An expanded paper becomes a seed: it gets its own card in the sidebar, is kept in the URL,
          // and its neighbourhood is replayed on reload / after other seeds are removed.
          if (!state.seeds.some((x) => x.paperId === id)) {
            set({ seeds: [...state.seeds, { lookup: id, paperId: id, status: 'ready' }] });
          }
          if (!state.graph.seeds.has(id)) {
            state.graph.addSeed(id, paper, get().papers);
            bumpGraph();
          }
          set({ expanding: new Set([...get().expanding, id]) });
          try {
            const [refs, cites] = await Promise.all([get().loadList(id, 'refs'), get().loadList(id, 'cites')]);
            const s = get();
            if (!s.graph.hasNode(id)) return; // removed meanwhile
            // Edges are drawn only from the lists of expanded seeds (no "free" discovery from other
            // cached lists), so the map always reflects exactly the papers you expanded.
            s.graph.mergeNeighborhood(
              id,
              refs.status === 'ready' ? refs.ids : null,
              cites.status === 'ready' ? cites.ids : null,
              s.papers,
              s.settings.graphExpandLimit,
            );
            bumpGraph();
            if (refs.status === 'error' || cites.status === 'error') {
              get().pushToast(`Could not load all connections: ${refs.error ?? cites.error}`, 'error');
            }
          } finally {
            const next = new Set(get().expanding);
            next.delete(id);
            set({ expanding: next });
            expandPromises.delete(id);
          }
        };
        const p = run();
        expandPromises.set(id, p);
        return p;
      },

      async refreshSeed(lookup) {
        const seed = get().seeds.find((x) => x.lookup === lookup);
        const id = seed?.paperId;
        if (!id) return;
        try {
          const fresh = await client.getPaper(id, 'full', { priority: PRIORITY.seed });
          upsertPapers([fresh]);
          const wasExpanded = get().graph.getNode(id)?.expanded ?? false;
          await Promise.all([get().loadList(id, 'refs', { force: true }), get().loadList(id, 'cites', { force: true })]);
          const s = get();
          if (wasExpanded) {
            // Rebuild from the (now fresh) lists so stale connections disappear; positions are kept by id.
            const seedIds = s.seeds.map((x) => x.paperId).filter((x): x is PaperId => !!x);
            s.graph.rebuild(seedIds, s.papers, s.settings.graphExpandLimit, cachedListIds);
          } else {
            s.graph.recompute(s.papers);
          }
          bumpGraph();
          get().pushToast('Paper data refreshed');
        } catch (e) {
          if (!isAbort(e)) get().pushToast(`Refresh failed: ${describeError(e)}`, 'error');
        }
      },

      async ensureDetail(id) {
        const p = get().papers.get(id);
        if (p && p.detailLevel === 'full') return p;
        try {
          const cached = await cache.getPaper(id);
          if (paperSatisfies(cached, 'full', now())) {
            upsertPapers([cached]);
            return cached;
          }
          const fetched = await client.getPaper(id, 'full', { priority: PRIORITY.detail });
          upsertPapers([fetched]);
          return get().papers.get(id);
        } catch (e) {
          if (!isAbort(e)) get().pushToast(describeError(e), 'error');
          return get().papers.get(id);
        }
      },

      async searchPapers(query) {
        const q = query.trim();
        searchCtrl?.abort();
        if (!q) {
          set({ search: null });
          return;
        }
        const ctrl = new AbortController();
        searchCtrl = ctrl;
        set({ search: { query: q, status: 'loading', ids: [], total: null } });
        try {
          const r = await client.search(q, 10, { signal: ctrl.signal });
          if (ctrl.signal.aborted) return;
          upsertPapers(r.papers);
          set({ search: { query: q, status: 'ready', ids: r.papers.map((p) => p.paperId), total: r.total } });
        } catch (e) {
          if (ctrl.signal.aborted || isAbort(e)) return;
          set({ search: { query: q, status: 'error', ids: [], total: null, error: describeError(e) } });
        }
      },

      clearSearch() {
        searchCtrl?.abort();
        searchCtrl = null;
        set({ search: null });
      },

      select(id) {
        if (get().selectedId !== id) set({ selectedId: id });
      },
      hover(id) {
        if (get().hoveredId !== id) set({ hoveredId: id });
      },
      setPinned(id, pinned) {
        get().graph.setPinned(id, pinned);
        bumpGraph();
      },
      unpinAll() {
        get().graph.unpinAll();
        bumpGraph();
      },

      updateSettings(patch) {
        const prev = get().settings;
        const next = sanitizeSettings({ ...prev, ...patch });
        set({ settings: next });
        saveSettings(next);
        if (next.apiKey !== prev.apiKey) queue.configure(next.apiKey ? AUTH_QUEUE : UNAUTH_QUEUE);
      },

      async clearCache() {
        await cache.clear();
        get().pushToast('Cache cleared');
      },

      pushToast(text, kind = 'info') {
        const id = ++toastSeq;
        set({ toasts: [...get().toasts, { id, text, kind }] });
        if (toastMs > 0) setTimeout(() => get().dismissToast(id), toastMs);
      },
      dismissToast(id) {
        const t = get().toasts;
        if (t.some((x) => x.id === id)) set({ toasts: t.filter((x) => x.id !== id) });
      },
    };
  });

  queue.onStatus((s) => {
    const cur = store.getState().queue;
    if (cur.pending !== s.pending || cur.active !== s.active || cur.pausedUntil !== s.pausedUntil) store.setState({ queue: s });
  });

  /** Swap the cache adapter (used once IndexedDB has opened). */
  const setCache = (c: CacheAdapter) => {
    cache = c;
  };

  return Object.assign(store, { setCache });
}

function listTotal(p: Paper | undefined, kind: ListKind, fallback: number): number {
  if (!p) return fallback;
  const n = kind === 'refs' ? p.referenceCount : p.citationCount;
  return Math.max(n, fallback);
}
