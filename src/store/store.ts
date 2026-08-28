import { create } from 'zustand';
import { isFresh, MemoryCache, paperAtLevel, PROVIDERS, TTL, type CacheAdapter, type CachedList } from '../api/cache';
import { ApiError, describeError, isAbort, NetworkError, NotFoundError, RateLimitedError } from '../api/errors';
import { hasUnicodeReplacement, mergePaper } from '../api/normalize';
import { PRIORITY } from '../api/provider';
import { AUTH_QUEUE, UNAUTH_QUEUE } from '../api/queue';
import type { ProviderStatus, Router } from '../api/router';
import { lookupFromZoteroItem, paperToConnectorItem, paperToZoteroItem, ZOTERO_LOCAL_USER, type ZoteroCollection, type ZoteroConnectorLike, type ZoteroItem, type ZoteroLike } from '../api/zotero';
import { arxivUrl, doiUrl, pdfUrl, truncate } from '../lib/format';
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

/** The Zotero-library half of a title search (absent when no Zotero source is configured). */
export interface SearchZoteroState {
  status: LoadStatus;
  items: ZoteroItem[];
  error?: string;
}

export interface SearchState {
  query: string;
  status: LoadStatus;
  ids: PaperId[];
  total: number | null;
  error?: string;
  provider?: ProviderId;
  zotero?: SearchZoteroState;
}

export interface ListsEntry {
  refs?: ListState;
  cites?: ListState;
  related?: ListState;
}

export interface ZoteroState {
  /** API-key verification. */
  status: 'idle' | 'checking' | 'ready' | 'error';
  error?: string;
  username: string;
  canWrite: boolean;
  /** Paper waiting for a collection choice before its first save. */
  savePendingId: PaperId | null;
  collectionDialogOpen: boolean;
  collections: ZoteroCollection[] | null;
  collectionsStatus: LoadStatus;
  collectionsError?: string;
  /** Session cache of library membership: item key when present, false = checked & absent. */
  savedKeys: Record<PaperId, string | false>;
  /** Where the last successful picker search was answered from. */
  searchSource: 'local' | 'web' | null;
  /** The running Zotero app answered a local request this session (enables keyless save UI). */
  localAvailable: boolean;
  /** The startup reachability probe has settled (gates UI that would otherwise flash). */
  localProbed: boolean;
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
  selectionHistory: PaperId[];
  selectionIndex: number;
  hoveredId: PaperId | null;
  search: SearchState | null;
  providers: Record<ProviderId, ProviderStatus>;
  settings: Settings;
  toasts: Toast[];
  zotero: ZoteroState;

  addSeeds(lookups: readonly Lookup[]): Promise<void>;
  removeSeed(lookup: Lookup): void;
  loadList(id: PaperId, kind: ListKind, opts?: { force?: boolean; limit?: number; signal?: AbortSignal }): Promise<ListState>;
  expandNode(id: PaperId): Promise<void>;
  /** Re-fetch a seed's details and lists from the network (bypassing caches) and rebuild the map. */
  refreshSeed(lookup: Lookup): Promise<void>;
  ensureDetail(id: PaperId): Promise<Paper | undefined>;
  searchPapers(query: string): Promise<void>;
  /**
   * As-you-type search of the LOCAL Zotero library only (never the web APIs).
   * Owns preview panels (search.status 'idle'); never touches submitted results.
   * An empty/short query clears the preview panel.
   */
  previewZoteroSearch(query: string): Promise<void>;
  clearSearch(): void;
  select(id: PaperId | null): void;
  selectPrevious(): void;
  selectNext(): void;
  /** Select by any id form (legacy sha, DOI, canonical id) once known. */
  selectByKey(key: string): Promise<void>;
  hover(id: PaperId | null): void;
  setPinned(id: PaperId, pinned: boolean): void;
  unpinAll(): void;
  updateSettings(patch: Partial<Settings>): void;
  clearCache(): Promise<void>;
  pushToast(text: string, kind?: Toast['kind'], ms?: number): void;
  dismissToast(id: number): void;

  /** Verify the configured Zotero API key and cache its userID/username. */
  zoteroVerifyKey(): Promise<boolean>;
  /** Quick-search the user's Zotero library (verifies the key first if needed). */
  zoteroSearch(query: string, signal?: AbortSignal): Promise<ZoteroItem[]>;
  /** Seed the map from a picked Zotero item; falls back to a title search when it has no identifier. */
  seedFromZoteroItem(item: ZoteroItem): Promise<void>;
  /** Save a paper to Zotero: into the running app when reachable (keyless), else via the web API. */
  zoteroSave(id: PaperId): Promise<void>;
  /** One startup ping to the running Zotero app, so keyless save UI can show. */
  zoteroProbeLocal(): Promise<void>;
  /** Lazily check (via the local API) whether a displayed paper is already in the library. */
  zoteroCheckLibrary(id: PaperId): Promise<void>;
  zoteroOpenCollectionDialog(): void;
  zoteroChooseCollection(key: string, name: string): void;
  zoteroCancelCollection(): void;
  /** (Re)load the collection list for the dialog; no-op while loading or already loaded. */
  zoteroLoadCollections(): Promise<void>;
}

export interface StoreDeps {
  router: Router;
  identity: Identity;
  cache: CacheAdapter;
  settings?: Settings;
  now?: () => number;
  /** Toast auto-dismiss (ms); 0 disables. */
  toastMs?: number;
  /** Delays before automatically retrying a seed that failed transiently; [] disables. */
  seedRetryDelays?: readonly number[];
  zotero?: ZoteroLike;
  /** Read-only client for the running Zotero app's local API; tried before `zotero` for searches. */
  zoteroLocal?: ZoteroLike;
  /** Keyless write path into the running Zotero app; tried before the web API for saves. */
  zoteroConnector?: ZoteroConnectorLike;
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
  const zotero = deps.zotero;
  const zoteroLocal = deps.zoteroLocal;
  const zoteroConnector = deps.zoteroConnector;
  let zoteroVerifyPromise: Promise<boolean> | null = null;
  let zoteroVerifySeq = 0;
  let cache = deps.cache;
  let cacheReady: Promise<void> = Promise.resolve();
  const now = deps.now ?? (() => Date.now());
  const toastMs = deps.toastMs ?? 3500;
  const seedRetryDelays = deps.seedRetryDelays ?? [20_000, 60_000];
  const listPromises = new Map<string, SharedListRequest>();
  const expandPromises = new Map<PaperId, Promise<void>>();
  const expandControllers = new Map<PaperId, AbortController>();
  /** Keys of stale entries currently being refreshed in the background. */
  const revalidating = new Set<string>();
  const seedRetryAttempts = new Map<string, number>();
  const seedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let searchCtrl: AbortController | null = null;
  let zoteroPreviewCtrl: AbortController | null = null;
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

    /** Refresh stale list-level metadata in the background (never blocks the caller). */
    const revalidatePapers = (ids: readonly PaperId[]): void => {
      const wanted = ids.filter((id) => !revalidating.has(`paper:${id}`));
      if (wanted.length === 0) return;
      for (const id of wanted) revalidating.add(`paper:${id}`);
      void router
        .getBatch(wanted, 'list', { priority: PRIORITY.revalidate })
        .then((papers) => upsertPapers(papers.filter((p): p is Paper => !!p)))
        .catch(() => {})
        .finally(() => {
          for (const id of wanted) revalidating.delete(`paper:${id}`);
        });
    };

    /** Refresh a stale full-detail record in the background. */
    const revalidateDetail = (id: PaperId): void => {
      if (revalidating.has(`full:${id}`)) return;
      const paper = get().papers.get(id);
      if (!paper) return;
      revalidating.add(`full:${id}`);
      void router
        .getPaper(paper, 'full', { priority: PRIORITY.revalidate })
        .then((fresh) => upsertPapers([{ ...fresh, paperId: id }]))
        .catch(() => {})
        .finally(() => revalidating.delete(`full:${id}`));
    };

    /**
     * Make sure every id has a Paper in the store: memory → cache → batch fetch.
     * A stale cached paper is served immediately and refreshed in the background.
     * With `network: false`, cache misses are simply left out (placeholder reads).
     */
    const ensurePapers = async (ids: readonly PaperId[], o: { network?: boolean } = {}): Promise<void> => {
      const missing = ids.filter((id) => !get().papers.has(id));
      if (missing.length === 0) return;
      const fromCache = await cache.getPapers(missing);
      const cachedHits: Paper[] = [];
      const staleIds: PaperId[] = [];
      const stillMissing: PaperId[] = [];
      for (const id of missing) {
        const p = fromCache.get(id);
        if (paperAtLevel(p, 'list')) {
          cachedHits.push(p);
          if (!isFresh(p.fetchedAt, TTL.paper, now())) staleIds.push(id);
        } else stillMissing.push(id);
      }
      upsertPapers(cachedHits);
      if (cachedHits.some(hasUnicodeReplacement)) {
        const repaired = await router.repairCorruptedMetadata(cachedHits, { priority: PRIORITY.list });
        upsertPapers(repaired);
      }
      if (staleIds.length) revalidatePapers(staleIds);
      if (stillMissing.length && o.network !== false) {
        const fetched = await router.getBatch(stillMissing, 'list', { priority: PRIORITY.list });
        upsertPapers(fetched.filter((p): p is Paper => !!p));
      }
    };

    /** Re-fetch a stale cached list in the background and swap it in when it lands. */
    const revalidateList = (id: PaperId, kind: ListKind, limit: number): void => {
      const key = `${kind}:${id}`;
      if (revalidating.has(key)) return;
      const paper = get().papers.get(id);
      if (!paper) return;
      revalidating.add(key);
      void router
        .getList(paper, kind, limit, { priority: PRIORITY.revalidate })
        .then((res) => {
          upsertPapers(res.papers);
          void cache.putList(id, kind, { ids: res.ids, limit, complete: !res.hasMore, fetchedAt: now(), provider: res.provider, total: res.total });
          const st: ListState = {
            ids: res.ids,
            status: 'ready',
            total: res.total ?? listTotal(get().papers.get(id), kind, res.ids.length),
            provider: res.provider,
            loadedLimit: limit,
            complete: !res.hasMore,
            missingCount: 0,
          };
          commitListState(get, setList, id, kind, st);
        })
        .catch(() => {})
        .finally(() => revalidating.delete(key));
    };

    /** Resolve one lookup from the alias table + paper cache; stale hits are served and refreshed in the background. */
    const resolveFromCache = async (lookup: Lookup): Promise<Paper | 'notfound' | null> => {
      const key = lookupToAliasKey(lookup);
      if (!key) return null;
      const entry = await identity.resolve(key);
      if (!entry) return null;
      if (entry.paperId === null) return isFresh(entry.fetchedAt, TTL.negativeLookup, now()) ? 'notfound' : null;
      const p = get().papers.get(entry.paperId) ?? (await cache.getPaper(entry.paperId));
      if (!paperAtLevel(p, 'list')) return null;
      if (!isFresh(p.fetchedAt, TTL.paper, now())) revalidatePapers([p.paperId]);
      return p;
    };

    const resolveFromNetwork = async (lookup: Lookup): Promise<Paper> => {
      return router.resolve(lookup, 'list', { priority: PRIORITY.seed });
    };

    /** One quiet retry ladder per seed that failed transiently — the rate limit usually clears within a minute. */
    const scheduleSeedRetry = (lookup: Lookup): void => {
      const key = lookupKey(lookup);
      const attempt = seedRetryAttempts.get(key) ?? 0;
      if (attempt >= seedRetryDelays.length || seedRetryTimers.has(key)) return;
      const timer = setTimeout(() => {
        seedRetryTimers.delete(key);
        seedRetryAttempts.set(key, attempt + 1);
        const seed = get().seeds.find((s) => lookupKey(s.lookup) === key);
        if (!seed || seed.status !== 'error' || !seed.retryable) return;
        get().removeSeed(seed.lookup);
        void get().addSeeds([seed.lookup]);
      }, seedRetryDelays[attempt]!);
      seedRetryTimers.set(key, timer);
    };

    const initialZotero = (localAvailable = false, localProbed = false): ZoteroState => ({
      status: 'idle',
      username: '',
      canWrite: false,
      savePendingId: null,
      collectionDialogOpen: false,
      collections: null,
      collectionsStatus: 'idle',
      savedKeys: {},
      searchSource: null,
      localAvailable,
      localProbed,
    });

    const setZotero = (patch: Partial<ZoteroState>): void => set({ zotero: { ...get().zotero, ...patch } });

    /** userID for API calls, verifying the key first when it isn't cached yet. */
    const zoteroUserId = async (): Promise<string> => {
      if (!get().settings.zoteroUserId) await get().zoteroVerifyKey();
      const id = get().settings.zoteroUserId;
      if (!id) throw new Error(get().zotero.error ?? 'Zotero API key not verified');
      return id;
    };

    const loadZoteroCollections = async (): Promise<void> => {
      if (!zotero) return;
      const z = get().zotero;
      if (z.collectionsStatus === 'loading' || z.collections) return;
      setZotero({ collectionsStatus: 'loading', collectionsError: undefined });
      try {
        const collections = await zotero.collections(await zoteroUserId());
        setZotero({ collections, collectionsStatus: 'ready' });
      } catch (e) {
        setZotero({ collectionsStatus: 'error', collectionsError: describeError(e) });
      }
    };

    /**
     * Save into the running Zotero app via the connector (keyless, instant, files into the
     * collection selected in Zotero). True = handled (saved, duplicate, or nothing to save);
     * false = connector unavailable/failed, caller should try the web API.
     */
    const tryConnectorSave = async (id: PaperId): Promise<boolean> => {
      if (!zoteroConnector) return false;
      const p = (await get().ensureDetail(id)) ?? get().papers.get(id);
      if (!p) return true;
      try {
        if (zoteroLocal && (p.externalIds.DOI || p.externalIds.ArXiv)) {
          const existing = await zoteroLocal.findByIds(ZOTERO_LOCAL_USER, { doi: p.externalIds.DOI, arxiv: p.externalIds.ArXiv });
          if (existing) {
            setZotero({ savedKeys: { ...get().zotero.savedKeys, [id]: existing.key }, localAvailable: true });
            get().pushToast('Already in your Zotero library');
            return true;
          }
        }
        const saved = await zoteroConnector.saveItem(
          paperToConnectorItem(p),
          doiUrl(p) ?? arxivUrl(p) ?? 'https://www.semanticscholar.org',
          pdfUrl(p) ?? undefined,
        );
        setZotero({ savedKeys: { ...get().zotero.savedKeys, [id]: 'local' }, localAvailable: true });
        get().pushToast(saved.pdfAttached ? 'Added to Zotero with PDF' : 'Added to Zotero');
        return true;
      } catch {
        return false;
      }
    };

    const performZoteroSave = async (id: PaperId): Promise<void> => {
      if (!zotero) return;
      try {
        const userId = await zoteroUserId();
        const p = (await get().ensureDetail(id)) ?? get().papers.get(id);
        if (!p) return;
        if (p.externalIds.DOI || p.externalIds.ArXiv) {
          const existing = await zotero.findByIds(userId, { doi: p.externalIds.DOI, arxiv: p.externalIds.ArXiv });
          if (existing) {
            setZotero({ savedKeys: { ...get().zotero.savedKeys, [id]: existing.key } });
            get().pushToast('Already in your Zotero library');
            return;
          }
        }
        const saved = await zotero.createItem(userId, paperToZoteroItem(p, get().settings.zoteroCollectionKey));
        setZotero({ savedKeys: { ...get().zotero.savedKeys, [id]: saved.key } });
        // Browsers can't reliably fetch cross-origin PDFs for a real upload, so the web
        // path attaches the open-access URL as a link attachment instead. Best-effort.
        const pdf = pdfUrl(p);
        if (pdf) {
          try {
            await zotero.createItem(userId, { itemType: 'attachment', linkMode: 'linked_url', parentItem: saved.key, title: 'Full Text PDF', url: pdf, contentType: 'application/pdf' });
          } catch {
            /* the item itself saved; the link is a bonus */
          }
        }
        get().pushToast('Added to Zotero');
      } catch (e) {
        if (!isAbort(e)) get().pushToast(describeError(e), 'error');
      }
    };

    return {
      papers: new Map(),
      seeds: [],
      lists: new Map(),
      graph: new GraphModel(),
      graphVersion: 0,
      expanding: new Set(),
      selectedId: null,
      selectionHistory: [],
      selectionIndex: -1,
      hoveredId: null,
      search: null,
      providers: router.status(),
      settings: initialSettings,
      toasts: [],
      zotero: initialZotero(),

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
              retryable: outcome.error ? isTransient(outcome.error) : false,
            });
          }
        }
        identity.aliasMany(aliases);
        identity.negativeMany(negatives);
        state.graph.addSeeds(graphEntries, nextPapers);
        set({ papers: nextPapers, seeds, graphVersion: state.graph.version });
        void cache.putPapers(changed);
        for (const [lookup, outcome] of outcomes) {
          if (outcome.paper) seedRetryAttempts.delete(lookupKey(lookup));
          else if (outcome.error && isTransient(outcome.error)) scheduleSeedRetry(lookup);
        }
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
            const candidates = opts.force ? [] : await cachedListCandidates(cache, id, kind);
            const cached = candidates.filter((l) => l.complete || l.limit >= limit).sort(rankCachedLists)[0];
            if (cached) {
              // A stale cached list is served immediately and refreshed in the background.
              await ensurePapers(cached.ids);
              const ids = cached.ids.filter((x) => get().papers.has(x));
              const st: ListState = {
                ids,
                status: 'ready',
                total: cached.total ?? listTotal(get().papers.get(id), kind, ids.length),
                provider: cached.provider,
                loadedLimit: cached.limit,
                complete: cached.complete,
                missingCount: cached.ids.length - ids.length,
              };
              const committed = commitListState(get, setList, id, kind, st);
              if (!isFresh(cached.fetchedAt, TTL.list, now())) revalidateList(id, kind, limit);
              return committed;
            }
            // A smaller cached prefix can't satisfy the request, but it beats an empty spinner.
            const partial = candidates.sort(rankCachedLists)[0];
            if (partial && partial.ids.length && !get().lists.get(id)?.[kind]?.ids.length) {
              void ensurePapers(partial.ids, { network: false })
                .then(() => {
                  const cur = get().lists.get(id)?.[kind];
                  if (cur?.status !== 'loading') return; // the real fetch already answered
                  const ids = partial.ids.filter((x) => get().papers.has(x));
                  if (ids.length) setList(id, kind, { ...cur, ids });
                })
                .catch(() => {});
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
              missingCount: 0,
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
        if (p.detailLevel === 'full') {
          if (!isFresh(p.fetchedAt, TTL.paper, now())) revalidateDetail(id);
          return p;
        }
        try {
          const cached = await cache.getPaper(id);
          if (paperAtLevel(cached, 'full')) {
            upsertPapers([cached]);
            if (!isFresh(cached.fetchedAt, TTL.paper, now())) revalidateDetail(id);
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
        zoteroPreviewCtrl?.abort();
        if (!q) {
          set({ search: null });
          return;
        }
        const ctrl = new AbortController();
        searchCtrl = ctrl;
        // Same no-flicker rule as the typing preview: only render the Zotero section when a
        // source is plausibly reachable. A silent probe recovers the flag once Zotero is back.
        if (zoteroLocal && !get().zotero.localAvailable) void get().zoteroProbeLocal();
        const zoteroAvailable = (!!zoteroLocal && get().zotero.localAvailable) || (!!zotero && !!get().settings.zoteroApiKey);
        set({ search: { query: q, status: 'loading', ids: [], total: null, zotero: zoteroAvailable ? { status: 'loading', items: [] } : undefined } });
        const patch = (p: Partial<SearchState>): void => {
          const cur = get().search;
          if (ctrl.signal.aborted || !cur || cur.query !== q) return;
          set({ search: { ...cur, ...p } });
        };
        // The Zotero library and the metadata providers answer independently; whichever is first renders first.
        if (zoteroAvailable) {
          void (async () => {
            try {
              const items = await get().zoteroSearch(q, ctrl.signal);
              patch({ zotero: { status: 'ready', items } });
            } catch (e) {
              if (isAbort(e)) return;
              // Without a key the user never opted into Zotero — drop the section instead of nagging.
              patch({ zotero: get().settings.zoteroApiKey ? { status: 'error', items: [], error: describeError(e) } : undefined });
            }
          })();
        }
        try {
          const r = await router.search(q, 10, { signal: ctrl.signal, priority: PRIORITY.search });
          if (ctrl.signal.aborted) return;
          upsertPapers(r.papers);
          patch({ status: 'ready', ids: dedupe(r.papers.map((p) => p.paperId)), total: r.total, provider: r.provider });
        } catch (e) {
          if (ctrl.signal.aborted || isAbort(e)) return;
          patch({ status: 'error', ids: [], total: null, error: describeError(e) });
        }
      },

      async previewZoteroSearch(query) {
        const q = query.trim();
        zoteroPreviewCtrl?.abort();
        zoteroPreviewCtrl = null;
        const cur = get().search;
        // Preview only with positive evidence Zotero is reachable — otherwise every keystroke
        // would flash the panel in (loading) and out (instant failure). Submitted searches
        // still try local unconditionally and turn the flag back on when Zotero returns.
        if (!zoteroLocal || !get().zotero.localAvailable || q.length < 2) {
          if (cur?.status === 'idle') set({ search: null });
          return;
        }
        const ctrl = new AbortController();
        zoteroPreviewCtrl = ctrl;
        // Keep the previous preview's rows visible while the next keystroke's answer loads.
        const carried = cur?.status === 'idle' && cur.zotero ? cur.zotero.items : [];
        set({ search: { query: q, status: 'idle', ids: [], total: null, zotero: { status: 'loading', items: carried } } });
        try {
          const items = await zoteroLocal.searchItems(ZOTERO_LOCAL_USER, q, { limit: 20, signal: ctrl.signal });
          const now = get().search;
          if (ctrl.signal.aborted || now?.query !== q || now.status !== 'idle') return;
          set({ search: { ...now, zotero: { status: 'ready', items } } });
          setZotero({ searchSource: 'local', localAvailable: true });
        } catch (e) {
          if (ctrl.signal.aborted || isAbort(e)) return;
          // Zotero went away: drop the panel and stop previewing until something local succeeds.
          setZotero({ localAvailable: false });
          const now = get().search;
          if (now?.query === q && now.status === 'idle') set({ search: null });
        }
      },

      clearSearch() {
        searchCtrl?.abort();
        zoteroPreviewCtrl?.abort();
        searchCtrl = null;
        zoteroPreviewCtrl = null;
        set({ search: null });
      },

      select(id) {
        const state = get();
        if (state.selectedId === id) return;
        if (id === null) {
          set({ selectedId: null });
          return;
        }
        const history = state.selectionHistory.slice(0, state.selectionIndex + 1);
        if (history.at(-1) !== id) history.push(id);
        set({ selectedId: id, selectionHistory: history, selectionIndex: history.length - 1 });
      },
      selectPrevious() {
        const state = get();
        if (state.selectionIndex <= 0) return;
        const selectionIndex = state.selectionIndex - 1;
        set({ selectionIndex, selectedId: state.selectionHistory[selectionIndex]! });
      },
      selectNext() {
        const state = get();
        if (state.selectionIndex < 0 || state.selectionIndex >= state.selectionHistory.length - 1) return;
        const selectionIndex = state.selectionIndex + 1;
        set({ selectionIndex, selectedId: state.selectionHistory[selectionIndex]! });
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
        if (next.zoteroApiKey !== prev.zoteroApiKey) {
          // The cached identity and collection belong to the old key; so does any in-flight verify.
          set({ settings: sanitizeSettings({ ...next, zoteroUserId: '', zoteroUsername: '', zoteroCollectionKey: '', zoteroCollectionName: '' }), zotero: initialZotero(get().zotero.localAvailable, get().zotero.localProbed) });
          zoteroVerifySeq++;
          zoteroVerifyPromise = null;
          if (next.zoteroApiKey) void get().zoteroVerifyKey();
        }
      },

      async clearCache() {
        await cache.clear();
        get().pushToast('Cache cleared');
      },

      pushToast(text, kind = 'info', ms = toastMs) {
        const id = ++toastSeq;
        set({ toasts: [...get().toasts, { id, text, kind }] });
        if (ms > 0) setTimeout(() => get().dismissToast(id), ms);
      },
      dismissToast(id) {
        const t = get().toasts;
        if (t.some((x) => x.id === id)) set({ toasts: t.filter((x) => x.id !== id) });
      },

      async zoteroVerifyKey() {
        const key = get().settings.zoteroApiKey;
        if (!zotero || !key) return false;
        if (zoteroVerifyPromise) return zoteroVerifyPromise;
        setZotero({ status: 'checking', error: undefined });
        const seq = ++zoteroVerifySeq;
        zoteroVerifyPromise = (async () => {
          try {
            const info = await zotero.keyInfo();
            if (get().settings.zoteroApiKey !== key) return false; // key changed mid-flight; this result is for the old one
            get().updateSettings({ zoteroUserId: String(info.userID), zoteroUsername: info.username });
            setZotero({ status: 'ready', username: info.username, canWrite: info.canWrite });
            return true;
          } catch (e) {
            if (get().settings.zoteroApiKey !== key) return false;
            setZotero({ status: 'error', error: describeError(e) });
            return false;
          } finally {
            if (seq === zoteroVerifySeq) zoteroVerifyPromise = null;
          }
        })();
        return zoteroVerifyPromise;
      },

      async zoteroSearch(query, signal) {
        // Local first: keyless, instant, and sees not-yet-synced items. Any failure
        // (Zotero closed, local API disabled, no proxy on a static deploy) falls through.
        if (zoteroLocal) {
          try {
            const items = await zoteroLocal.searchItems(ZOTERO_LOCAL_USER, query, { limit: 20, signal });
            setZotero({ searchSource: 'local', localAvailable: true });
            return items;
          } catch (e) {
            if (isAbort(e)) throw e;
          }
        }
        if (!zotero || !get().settings.zoteroApiKey) {
          throw new Error('Zotero is not reachable — start Zotero and enable its local API (Settings → Advanced → “Allow other applications…”), or add a Zotero API key in Settings');
        }
        const items = await zotero.searchItems(await zoteroUserId(), query, { limit: 20, signal });
        setZotero({ searchSource: 'web' });
        return items;
      },

      async seedFromZoteroItem(item) {
        const lookup = lookupFromZoteroItem(item);
        if (lookup) {
          // The optimistic seed card renders synchronously, so the picker can close right away.
          void get().addSeeds([lookup]);
          return;
        }
        const title = (item.data.title ?? '').trim();
        if (!title) {
          get().pushToast('This Zotero item has no identifier or title to match', 'error');
          return;
        }
        try {
          const r = await router.search(title, 5, { priority: PRIORITY.search });
          const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
          const best = r.papers.find((p) => norm(p.title) === norm(title)) ?? r.papers[0];
          if (!best) {
            get().pushToast(`No match found for "${truncate(title, 60)}"`, 'error');
            return;
          }
          upsertPapers([best]);
          await get().addSeeds([best.paperId]);
          get().pushToast(`Matched by title — verify: "${truncate(best.title, 60)}"`);
        } catch (e) {
          if (!isAbort(e)) get().pushToast(describeError(e), 'error');
        }
      },

      async zoteroSave(id) {
        if (get().zotero.savedKeys[id]) return;
        const canWeb = !!zotero && !!get().settings.zoteroApiKey;
        if (!zoteroConnector && !canWeb) return;
        if (await tryConnectorSave(id)) return;
        if (!canWeb) {
          get().pushToast('Zotero isn’t running — start it, or add a Zotero API key in Settings to save via zotero.org', 'error');
          return;
        }
        if (get().settings.zoteroCollectionName === '') {
          setZotero({ savePendingId: id, collectionDialogOpen: true });
          void loadZoteroCollections();
          return;
        }
        await performZoteroSave(id);
      },

      async zoteroProbeLocal() {
        if (!zoteroLocal) return;
        try {
          await zoteroLocal.searchItems(ZOTERO_LOCAL_USER, '', { limit: 1 });
          setZotero({ localAvailable: true, localProbed: true });
        } catch {
          setZotero({ localAvailable: false, localProbed: true });
        }
      },

      async zoteroCheckLibrary(id) {
        if (!zoteroLocal || !get().zotero.localAvailable) return;
        if (get().zotero.savedKeys[id] !== undefined) return;
        const p = get().papers.get(id);
        if (!p || (!p.externalIds.DOI && !p.externalIds.ArXiv)) return;
        try {
          const existing = await zoteroLocal.findByIds(ZOTERO_LOCAL_USER, { doi: p.externalIds.DOI, arxiv: p.externalIds.ArXiv });
          if (get().zotero.savedKeys[id] !== undefined) return; // a save landed meanwhile
          setZotero({ savedKeys: { ...get().zotero.savedKeys, [id]: existing?.key ?? false } });
        } catch {
          /* Zotero closed mid-session — stay unknown, the save flow re-checks anyway */
        }
      },

      zoteroOpenCollectionDialog() {
        setZotero({ collectionDialogOpen: true, savePendingId: null });
        void loadZoteroCollections();
      },
      zoteroLoadCollections() {
        return loadZoteroCollections();
      },
      zoteroChooseCollection(key, name) {
        const pending = get().zotero.savePendingId;
        get().updateSettings({ zoteroCollectionKey: key, zoteroCollectionName: name || 'My Library' });
        setZotero({ collectionDialogOpen: false, savePendingId: null });
        if (pending) void performZoteroSave(pending);
      },
      zoteroCancelCollection() {
        setZotero({ collectionDialogOpen: false, savePendingId: null });
      },
    };
  });

  let s2WasPaused = false;
  let s2PauseEvents = 0;
  let apiKeyHintShown = false;
  router.onStatus((s) => {
    const cur = store.getState().providers;
    if (JSON.stringify(cur) !== JSON.stringify(s)) store.setState({ providers: s });
    // Repeated anonymous rate-limiting has a one-line cure the user may not know about.
    const paused = (s.s2?.pausedUntil ?? null) !== null;
    if (paused && !s2WasPaused) {
      s2PauseEvents++;
      if (s2PauseEvents >= 2 && !apiKeyHintShown && !store.getState().settings.apiKey) {
        apiKeyHintShown = true;
        store.getState().pushToast('Semantic Scholar keeps rate-limiting anonymous requests — a free S2 API key in Settings makes loading faster and more reliable', 'info', 8000);
      }
    }
    s2WasPaused = paused;
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

/** Worth retrying automatically: the provider was unreachable or overloaded, not a definitive miss. */
function isTransient(e: unknown): boolean {
  return e instanceof RateLimitedError || e instanceof NetworkError || (e instanceof ApiError && e.status >= 500);
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

async function cachedListCandidates(cache: CacheAdapter, id: PaperId, kind: ListKind): Promise<CachedList[]> {
  const all = await Promise.all(PROVIDERS.map((provider) => cache.getList(id, kind, provider)));
  return all.filter((list): list is CachedList => !!list);
}

function rankCachedLists(a: CachedList, b: CachedList): number {
  return Number(b.complete) - Number(a.complete) || b.limit - a.limit || b.fetchedAt - a.fetchedAt;
}

async function migrateMemoryCache(source: MemoryCache, target: CacheAdapter): Promise<void> {
  await target.putPapers([...source.papers.values()]);
  const listWrites: Promise<void>[] = [];
  for (const [key, list] of source.lists) {
    const match = /^(.*):(refs|cites|related):(s2|openalex)$/.exec(key);
    if (match) listWrites.push(target.putList(match[1]!, match[2]! as ListKind, list));
  }
  await Promise.all(listWrites);
  await target.putLookups([...source.lookups]);
}

function listTotal(p: Paper | undefined, kind: ListKind, fallback: number): number {
  if (!p) return fallback;
  const n = kind === 'refs' ? p.referenceCount : kind === 'cites' ? p.citationCount : fallback;
  return Math.max(n, fallback);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
