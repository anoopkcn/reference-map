import { create } from 'zustand';
import { isFresh, MemoryCache, paperSatisfies, PROVIDERS, TTL, type CacheAdapter, type CachedList } from '../api/cache';
import { describeError, isAbort, NotFoundError } from '../api/errors';
import { mergePaper } from '../api/normalize';
import { PRIORITY } from '../api/provider';
import { AUTH_QUEUE, UNAUTH_QUEUE } from '../api/queue';
import type { ProviderStatus, Router } from '../api/router';
import { Identity, lookupToAliasKey } from '../lib/identity';
import { lookupKey } from '../lib/ids';
import { DEFAULT_SETTINGS, type ListKind, type ListState, type LoadStatus, type Lookup, type Paper, type PaperId, type ProviderId, type Seed, type Settings } from '../types';
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
  provider?: ProviderId;
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
  providers: Record<ProviderId, ProviderStatus>;
  settings: Settings;
  toasts: Toast[];

  addSeeds(lookups: readonly Lookup[]): Promise<void>;
  removeSeed(lookup: Lookup): void;
  loadList(id: PaperId, kind: ListKind, opts?: { force?: boolean; limit?: number; signal?: AbortSignal }): Promise<ListState>;
  expandNode(id: PaperId): Promise<void>;
  /** Re-fetch a seed's details and lists from the network (bypassing caches) and rebuild the map. */
  refreshSeed(lookup: Lookup): Promise<void>;
  ensureDetail(id: PaperId): Promise<Paper | undefined>;
  searchPapers(query: string): Promise<void>;
  clearSearch(): void;
  select(id: PaperId | null): void;
  /** Select by any id form (legacy sha, DOI, canonical id) once known. */
  selectByKey(key: string): Promise<void>;
  hover(id: PaperId | null): void;
  setPinned(id: PaperId, pinned: boolean): void;
  unpinAll(): void;
  updateSettings(patch: Partial<Settings>): void;
  clearCache(): Promise<void>;
  pushToast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

export interface StoreDeps {
  router: Router;
  identity: Identity;
  cache: CacheAdapter;
  settings?: Settings;
  now?: () => number;
  /** Toast auto-dismiss (ms); 0 disables. */
  toastMs?: number;
}

export type AppStore = ReturnType<typeof createAppStore>;

interface SharedListRequest {
  promise: Promise<ListState>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
}

const BATCH_THRESHOLD = 3;

export function createAppStore(deps: StoreDeps) {
  const { router, identity } = deps;
  let cache = deps.cache;
  let cacheReady: Promise<void> = Promise.resolve();
  const now = deps.now ?? (() => Date.now());
  const toastMs = deps.toastMs ?? 3500;
  const listPromises = new Map<string, SharedListRequest>();
  const expandPromises = new Map<PaperId, Promise<void>>();
  const expandControllers = new Map<PaperId, AbortController>();
  let searchCtrl: AbortController | null = null;
  let toastSeq = 0;
  let settingsTimer: ReturnType<typeof setTimeout> | null = null;

  const initialSettings = sanitizeSettings(deps.settings ?? DEFAULT_SETTINGS);
  router.providers.s2?.queue.configure(initialSettings.apiKey ? AUTH_QUEUE : UNAUTH_QUEUE);

  const store = create<AppState>()((set, get) => {
    /** Merge papers into the store (one Map copy per batch) and persist. */
    const upsertPapers = (incoming: readonly Paper[]): void => {
      if (incoming.length === 0) return;
      const prev = get().papers;
      const next = new Map(prev);
      const changed: Paper[] = [];
      for (const p of incoming) {
        const merged = mergePaper(next.get(p.paperId), p);
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
        const fetched = await router.getBatch(stillMissing, 'list', { priority: PRIORITY.list });
        upsertPapers(fetched.filter((p): p is Paper => !!p));
      }
    };

    /** Resolve one lookup from the alias table + paper cache. */
    const resolveFromCache = async (lookup: Lookup): Promise<Paper | 'notfound' | null> => {
      const key = lookupToAliasKey(lookup);
      if (!key) return null;
      const entry = await identity.resolve(key);
      if (!entry) return null;
      if (entry.paperId === null) return isFresh(entry.fetchedAt, TTL.negativeLookup, now()) ? 'notfound' : null;
      const p = get().papers.get(entry.paperId) ?? (await cache.getPaper(entry.paperId));
      return paperSatisfies(p, 'list', now()) ? p : null;
    };

    const resolveFromNetwork = async (lookup: Lookup): Promise<Paper> => {
      return router.resolve(lookup, 'list', { priority: PRIORITY.seed });
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
      providers: router.status(),
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

        // The shell and resolving cards render immediately, while URL restoration waits for the
        // persistent cache decision. This prevents a late IndexedDB adoption from duplicating work.
        await cacheReady;

        type Outcome = { paper?: Paper; error?: unknown; notFound?: boolean };
        const outcomes = new Map<Lookup, Outcome>();
        const needNetwork: Lookup[] = [];
        await Promise.all(
          fresh.map(async (lookup) => {
            try {
              const r = await resolveFromCache(lookup);
              if (r === 'notfound') outcomes.set(lookup, { notFound: true });
              else if (r) outcomes.set(lookup, { paper: r });
              else needNetwork.push(lookup);
            } catch {
              needNetwork.push(lookup);
            }
          }),
        );
        let retry = needNetwork;
        if (needNetwork.length >= BATCH_THRESHOLD) {
          try {
            const results = await router.getBatch(needNetwork, 'list', { priority: PRIORITY.batch });
            retry = [];
            needNetwork.forEach((lookup, i) => {
              const paper = results[i];
              if (paper) outcomes.set(lookup, { paper });
              else retry.push(lookup);
            });
          } catch {
            retry = needNetwork;
          }
        }
        await Promise.all(
          retry.map(async (lookup) => {
            try {
              outcomes.set(lookup, { paper: await resolveFromNetwork(lookup) });
            } catch (e) {
              outcomes.set(lookup, e instanceof NotFoundError ? { notFound: true } : { error: e });
            }
          }),
        );

        const state = get();
        const nextPapers = new Map(state.papers);
        const changed: Paper[] = [];
        for (const { paper } of outcomes.values()) {
          if (!paper) continue;
          const merged = mergePaper(nextPapers.get(paper.paperId), paper);
          nextPapers.set(paper.paperId, merged);
          changed.push(merged);
        }

        const seenIds = new Set(
          state.seeds.filter((seed) => !outcomes.has(seed.lookup)).map((seed) => seed.paperId).filter((id): id is PaperId => !!id),
        );
        const graphEntries: [PaperId, Paper][] = [];
        const aliases: [string, PaperId][] = [];
        const negatives: string[] = [];
        let duplicate = false;
        const seeds: Seed[] = [];
        for (const seed of state.seeds) {
          const outcome = outcomes.get(seed.lookup);
          if (!outcome) {
            seeds.push(seed);
            continue;
          }
          const key = lookupToAliasKey(seed.lookup);
          if (outcome.paper) {
            const id = outcome.paper.paperId;
            if (key) aliases.push([key, id]);
            if (seenIds.has(id)) {
              duplicate = true;
              continue;
            }
            seenIds.add(id);
            seeds.push({ lookup: seed.lookup, paperId: id, status: 'ready', error: undefined });
            graphEntries.push([id, nextPapers.get(id)!]);
          } else {
            if (outcome.notFound && key) negatives.push(key);
            seeds.push({
              lookup: seed.lookup,
              paperId: null,
              status: 'error',
              error: outcome.error ? describeError(outcome.error) : 'Not found on Semantic Scholar or OpenAlex',
            });
          }
        }
        identity.aliasMany(aliases);
        identity.negativeMany(negatives);
        state.graph.addSeeds(graphEntries, nextPapers);
        set({ papers: nextPapers, seeds, graphVersion: state.graph.version });
        void cache.putPapers(changed);
        if (duplicate) get().pushToast('Already in the map');
        if (get().settings.autoExpandSeeds) for (const [id] of graphEntries) void get().expandNode(id);
      },

      removeSeed(lookup) {
        const state = get();
        const removedId = state.seeds.find((seed) => seed.lookup === lookup)?.paperId;
        if (removedId) expandControllers.get(removedId)?.abort();
        const seeds = state.seeds.filter((s) => s.lookup !== lookup);
        set({ seeds });
        const seedIds = seeds.map((s) => s.paperId).filter((id): id is PaperId => !!id);
        state.graph.rebuild(seedIds, state.papers, state.settings.graphExpandLimit, cachedListIds);
        bumpGraph();
        if (state.selectedId && !state.graph.hasNode(state.selectedId)) set({ selectedId: null });
      },

      loadList(id, kind, opts = {}) {
        const limit = Math.max(1, Math.floor(opts.limit ?? get().settings.listLimit));
        const key = `${id}:${kind}:${limit}:${opts.force ? 'force' : 'cached'}`;
        const existing = get().lists.get(id)?.[kind];
        if (!opts.force && listStateSatisfies(existing, limit)) return Promise.resolve(existing);
        const inflight = listPromises.get(key);
        if (inflight) return consumeListRequest(inflight, opts.signal, () => get().lists.get(id)?.[kind] ?? idleListState());

        const controller = new AbortController();
        const request: SharedListRequest = { promise: Promise.resolve(idleListState()), controller, consumers: 0, settled: false };

        const run = async (): Promise<ListState> => {
          setList(id, kind, {
            ids: existing?.ids ?? [],
            status: 'loading',
            total: existing?.total ?? null,
            provider: existing?.provider,
            loadedLimit: existing?.loadedLimit ?? 0,
            complete: existing?.complete ?? false,
          });
          try {
            const paper = get().papers.get(id);
            if (!paper) throw new Error('Paper not loaded');
            const cached = opts.force ? undefined : await bestCachedList(cache, id, kind, limit, now());
            if (cached) {
              await ensurePapers(cached.ids);
              const ids = cached.ids.filter((x) => get().papers.has(x));
              const st: ListState = {
                ids,
                status: 'ready',
                total: cached.total ?? listTotal(get().papers.get(id), kind, ids.length),
                provider: cached.provider,
                loadedLimit: cached.limit,
                complete: cached.complete,
              };
              return commitListState(get, setList, id, kind, st);
            }
            const res = await router.getList(paper, kind, limit, { priority: PRIORITY.list, signal: controller.signal });
            upsertPapers(res.papers);
            void cache.putList(id, kind, { ids: res.ids, limit, complete: !res.hasMore, fetchedAt: now(), provider: res.provider, total: res.total });
            const st: ListState = {
              ids: res.ids,
              status: 'ready',
              total: res.total ?? listTotal(get().papers.get(id), kind, res.ids.length),
              provider: res.provider,
              loadedLimit: limit,
              complete: !res.hasMore,
            };
            return commitListState(get, setList, id, kind, st);
          } catch (e) {
            const current = get().lists.get(id)?.[kind];
            if (current?.status === 'ready') return current;
            if (isAbort(e)) {
              const st = existing?.status === 'ready' ? existing : idleListState(existing);
              setList(id, kind, st);
              return st;
            }
            const st: ListState = { ids: [], status: 'error', total: null, error: describeError(e), loadedLimit: 0, complete: false };
            setList(id, kind, st);
            return st;
          } finally {
            request.settled = true;
            if (listPromises.get(key) === request) listPromises.delete(key);
          }
        };
        request.promise = run();
        listPromises.set(key, request);
        return consumeListRequest(request, opts.signal, () => get().lists.get(id)?.[kind] ?? idleListState());
      },

      expandNode(id) {
        const running = expandPromises.get(id);
        if (running) return running;
        const controller = new AbortController();
        expandControllers.set(id, controller);
        const run = async () => {
          const state = get();
          const paper = state.papers.get(id);
          if (!paper) return;
          // An expanded paper becomes a seed: its own card, kept in the URL, replayed on reload.
          if (!state.seeds.some((x) => x.paperId === id)) {
            set({ seeds: [...state.seeds, { lookup: id, paperId: id, status: 'ready' }] });
          }
          if (!state.graph.seeds.has(id)) {
            state.graph.addSeed(id, paper, get().papers);
            bumpGraph();
          }
          set({ expanding: new Set([...get().expanding, id]) });
          try {
            const limit = get().settings.graphExpandLimit;
            const [refs, cites] = await Promise.all([
              get().loadList(id, 'refs', { limit, signal: controller.signal }),
              get().loadList(id, 'cites', { limit, signal: controller.signal }),
            ]);
            const s = get();
            if (controller.signal.aborted || !s.graph.hasNode(id)) return; // removed meanwhile
            s.graph.mergeNeighborhood(id, refs.status === 'ready' ? refs.ids : null, cites.status === 'ready' ? cites.ids : null, s.papers, s.settings.graphExpandLimit);
            bumpGraph();
            if (refs.status === 'error' || cites.status === 'error') {
              get().pushToast(`Could not load all connections: ${refs.error ?? cites.error}`, 'error');
            }
          } finally {
            const next = new Set(get().expanding);
            next.delete(id);
            set({ expanding: next });
            expandPromises.delete(id);
            if (expandControllers.get(id) === controller) expandControllers.delete(id);
          }
        };
        const p = run();
        expandPromises.set(id, p);
        return p;
      },

      async refreshSeed(lookup) {
        const seed = get().seeds.find((x) => x.lookup === lookup);
        const id = seed?.paperId;
        const paper = id ? get().papers.get(id) : undefined;
        if (!id || !paper) return;
        try {
          const fresh = await router.getPaper(paper, 'full', { priority: PRIORITY.seed });
          upsertPapers([{ ...fresh, paperId: id }]);
          const wasExpanded = get().graph.getNode(id)?.expanded ?? false;
          await Promise.all([get().loadList(id, 'refs', { force: true }), get().loadList(id, 'cites', { force: true })]);
          const s = get();
          if (wasExpanded) {
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
        if (!p) return undefined;
        if (p.detailLevel === 'full') return p;
        try {
          const cached = await cache.getPaper(id);
          if (paperSatisfies(cached, 'full', now())) {
            upsertPapers([cached]);
            return get().papers.get(id);
          }
          const fetched = await router.getPaper(p, 'full', { priority: PRIORITY.detail });
          upsertPapers([{ ...fetched, paperId: id }]);
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
          const r = await router.search(q, 10, { signal: ctrl.signal, priority: PRIORITY.search });
          if (ctrl.signal.aborted) return;
          upsertPapers(r.papers);
          set({ search: { query: q, status: 'ready', ids: dedupe(r.papers.map((p) => p.paperId)), total: r.total, provider: r.provider } });
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
      async selectByKey(key) {
        const k = lookupToAliasKey(key) ?? key;
        const e = await identity.resolve(k);
        get().select(e?.paperId ?? key);
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
        if (settingsTimer) clearTimeout(settingsTimer);
        settingsTimer = setTimeout(() => {
          settingsTimer = null;
          saveSettings(get().settings);
        }, 150);
        if (next.apiKey !== prev.apiKey) router.providers.s2?.queue.configure(next.apiKey ? AUTH_QUEUE : UNAUTH_QUEUE);
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

  router.onStatus((s) => {
    const cur = store.getState().providers;
    if (JSON.stringify(cur) !== JSON.stringify(s)) store.setState({ providers: s });
  });

  /** Adopt a persistent cache without delaying React mount or losing memory writes. */
  const prepareCache = (pending: Promise<CacheAdapter>): Promise<void> => {
    cacheReady = cacheReady.then(async () => {
      const next = await pending;
      if (next === cache) return;
      const previous = cache;
      // Route new writes to the destination before copying the synchronous memory snapshot.
      cache = next;
      identity.setCache(next);
      if (previous instanceof MemoryCache) await migrateMemoryCache(previous, next);
    });
    return cacheReady;
  };

  return Object.assign(store, { prepareCache });
}

function listStateSatisfies(state: ListState | undefined, limit: number): state is ListState {
  return !!state && state.status === 'ready' && (state.complete || state.loadedLimit >= limit);
}

function idleListState(previous?: ListState): ListState {
  return {
    ids: previous?.ids ?? [],
    status: 'idle',
    total: previous?.total ?? null,
    provider: previous?.provider,
    loadedLimit: previous?.loadedLimit ?? 0,
    complete: previous?.complete ?? false,
  };
}

function consumeListRequest(request: SharedListRequest, signal: AbortSignal | undefined, fallback: () => ListState): Promise<ListState> {
  request.consumers++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    request.consumers--;
    if (!request.settled && request.consumers === 0) request.controller.abort();
  };
  if (!signal) return request.promise.finally(release);
  if (signal.aborted) {
    release();
    return Promise.resolve(fallback());
  }
  return new Promise<ListState>((resolve, reject) => {
    const onAbort = () => {
      release();
      resolve(fallback());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.promise.then(
      (state) => {
        signal.removeEventListener('abort', onAbort);
        release();
        resolve(state);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

function preferListState(previous: ListState | undefined, next: ListState): ListState {
  if (!previous || previous.status !== 'ready') return next;
  if (previous.complete !== next.complete) return previous.complete ? previous : next;
  if (previous.loadedLimit !== next.loadedLimit) return previous.loadedLimit > next.loadedLimit ? previous : next;
  return next;
}

function commitListState(
  get: () => AppState,
  setList: (id: PaperId, kind: ListKind, state: ListState) => void,
  id: PaperId,
  kind: ListKind,
  incoming: ListState,
): ListState {
  const preferred = preferListState(get().lists.get(id)?.[kind], incoming);
  setList(id, kind, preferred);
  return preferred;
}

async function bestCachedList(cache: CacheAdapter, id: PaperId, kind: ListKind, limit: number, now: number): Promise<CachedList | undefined> {
  const candidates = await Promise.all(PROVIDERS.map((provider) => cache.getList(id, kind, provider)));
  return candidates
    .filter((list): list is CachedList => !!list && isFresh(list.fetchedAt, TTL.list, now) && (list.complete || list.limit >= limit))
    .sort((a, b) => Number(b.complete) - Number(a.complete) || b.limit - a.limit || b.fetchedAt - a.fetchedAt)[0];
}

async function migrateMemoryCache(source: MemoryCache, target: CacheAdapter): Promise<void> {
  await target.putPapers([...source.papers.values()]);
  const listWrites: Promise<void>[] = [];
  for (const [key, list] of source.lists) {
    const match = /^(.*):(refs|cites):(s2|openalex)$/.exec(key);
    if (match) listWrites.push(target.putList(match[1]!, match[2]! as ListKind, list));
  }
  await Promise.all(listWrites);
  await target.putLookups([...source.lookups]);
}

function listTotal(p: Paper | undefined, kind: ListKind, fallback: number): number {
  if (!p) return fallback;
  const n = kind === 'refs' ? p.referenceCount : p.citationCount;
  return Math.max(n, fallback);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
