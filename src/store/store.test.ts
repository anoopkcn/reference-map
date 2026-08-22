import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCache, type CacheAdapter } from '../api/cache';
import { NetworkError, NotFoundError, UnsupportedLookupError } from '../api/errors';
import { ProviderStats, type ListResult, type Provider, type SearchResult } from '../api/provider';
import { RequestQueue, type EnqueueOptions } from '../api/queue';
import { Router } from '../api/router';
import { Identity } from '../lib/identity';
import { DEFAULT_SETTINGS, type DetailLevel, type ListKind, type Lookup, type Paper, type ProviderId } from '../types';
import { createAppStore } from './store';

/** Shared dataset: papers S, A, B, C with DOIs; S2 and OpenAlex both know them under native ids. */
const DOIS: Record<string, string> = { S: '10.1/s', A: '10.1/a', B: '10.1/b', C: '10.1/c' };
const mk = (pid: ProviderId, key: string, level: DetailLevel = 'list'): Paper => ({
  paperId: pid === 's2' ? `s2:sha${key}` : `oa:W${key}`,
  sources: pid === 's2' ? { s2: `sha${key}` } : { openalex: `W${key}` },
  title: `Paper ${key}`,
  year: 2020,
  authors: [{ authorId: null, name: `Auth ${key}`, provider: pid }],
  venue: pid === 'openalex' ? `Venue ${key}` : '',
  journal: null,
  citationCount: pid === 's2' ? 10 : 11,
  referenceCount: 2,
  influentialCitationCount: pid === 's2' ? 1 : null,
  externalIds: { DOI: DOIS[key]! },
  isOpenAccess: false,
  openAccessPdf: pid === 'openalex' ? { url: `https://oa/${key}.pdf` } : null,
  publicationTypes: [],
  publicationDate: null,
  detailLevel: level,
  fetchedAt: 1,
  ...(level === 'full' ? { abstract: `Abstract ${key}`, bibtex: pid === 's2' ? `@x{${key}}` : null } : {}),
});
const LISTS: Record<string, Record<ListKind, string[]>> = {
  S: { refs: ['A', 'B'], cites: ['C'], related: ['C', 'B'] },
  A: { refs: ['B'], cites: [], related: [] },
  B: { refs: [], cites: [], related: [] },
  C: { refs: [], cites: [], related: [] },
};

class FakeProvider implements Provider {
  readonly queue = new RequestQueue({ concurrency: 4, minIntervalMs: 0 });
  readonly stats = new ProviderStats();
  calls: string[] = [];
  fail: unknown = null;
  failBatch: unknown = null;
  listDelays = new Map<number, number>();
  listAborted = 0;
  constructor(readonly id: ProviderId) {}
  private keyOf(lookup: string): string | null {
    const m = /^(?:DOI:|doi:)(10\.1\/([a-z]))$/i.exec(lookup);
    if (m) return m[2]!.toUpperCase();
    const n = this.id === 's2' ? /^(?:s2:)?sha([A-Z])$/.exec(lookup) : /^(?:oa:)?W([A-Z])$/.exec(lookup);
    return n ? n[1]! : null;
  }
  toNative(lookup: Lookup) {
    if (this.id === 's2' && /^ARXIV:/i.test(lookup)) return lookup; // S2-only capability
    if (/^(DOI:|doi:)/i.test(lookup)) return lookup;
    return this.keyOf(lookup) ? lookup : null;
  }
  lookupFor(p: Pick<Paper, 'sources' | 'externalIds'>) {
    return (this.id === 's2' ? p.sources.s2 : p.sources.openalex) ?? (p.externalIds.DOI ? `DOI:${p.externalIds.DOI}` : null);
  }
  supportsList(kind: ListKind) {
    return kind !== 'related' || this.id === 'openalex';
  }
  private async go<T>(label: string, make: () => T): Promise<T> {
    this.calls.push(label);
    if (this.fail) {
      this.stats.record('detail', false, 0, this.fail);
      throw this.fail;
    }
    this.stats.record('detail', true, 5);
    return make();
  }
  resolve(lookup: Lookup, level: DetailLevel, _o?: EnqueueOptions) {
    return this.go(`resolve:${lookup}`, () => {
      const k = this.keyOf(lookup);
      if (!k || !DOIS[k]) throw new NotFoundError('nf', undefined, this.id);
      return mk(this.id, k, level);
    });
  }
  getPaper(native: string, level: DetailLevel, _o?: EnqueueOptions) {
    return this.go(`paper:${native}`, () => {
      const k = this.keyOf(native);
      if (!k) throw new NotFoundError('nf', undefined, this.id);
      return mk(this.id, k, level);
    });
  }
  async getList(native: string, kind: ListKind, limit: number, _o?: EnqueueOptions): Promise<ListResult> {
    const delay = this.listDelays.get(limit) ?? 0;
    if (delay) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        _o?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          this.listAborted++;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    return this.go(`${kind}:${native}:${limit}`, () => {
      const k = this.keyOf(native)!;
      const all = LISTS[k]![kind];
      const papers = all.slice(0, limit).map((x) => mk(this.id, x));
      const total = k === 'S' && kind === 'cites' ? 453 : all.length;
      return { ids: papers.map((p) => p.paperId), papers, hasMore: total > papers.length, total };
    });
  }
  async getBatch(lookups: readonly Lookup[], level: DetailLevel, _o?: EnqueueOptions) {
    this.calls.push(`batch:${lookups.join(',')}`);
    if (this.failBatch) {
      this.stats.record('batch', false, 0, this.failBatch);
      throw this.failBatch;
    }
    return lookups.map((l) => {
      const k = this.toNative(l) ? this.keyOf(l) : null;
      return k && DOIS[k] ? mk(this.id, k, level) : null;
    });
  }
  search(query: string, _limit: number, _o?: EnqueueOptions): Promise<SearchResult> {
    return this.go(`search:${query}`, () => ({ papers: [mk(this.id, 'A'), mk(this.id, 'B')], total: 2 }));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('store (two providers)', () => {
  let cache: MemoryCache;
  let s2: FakeProvider;
  let oa: FakeProvider;
  beforeEach(() => {
    cache = new MemoryCache();
    s2 = new FakeProvider('s2');
    oa = new FakeProvider('openalex');
  });

  const make = (over: { cache?: MemoryCache; settings?: Partial<typeof DEFAULT_SETTINGS> } = {}) => {
    const c = over.cache ?? cache;
    const identity = new Identity(c);
    const store = createAppStore({
      router: new Router({ providers: [s2, oa], identity, getMode: () => store.getState().settings.sourceMode, softTimeoutMs: 4000 }),
      identity,
      cache: c,
      settings: { ...DEFAULT_SETTINGS, ...over.settings },
      toastMs: 0,
      now: () => 10,
    });
    return store;
  };

  it('addSeeds resolves via the healthy provider, canonicalises to a DOI id, auto-expands and reuses lists', async () => {
    const store = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    const s = store.getState();
    expect(s.seeds).toEqual([{ lookup: 'DOI:10.1/s', paperId: 'doi:10.1/s', status: 'ready', error: undefined }]);
    expect(s2.calls.filter((c) => c.startsWith('resolve')).length).toBe(1);
    expect(oa.calls).toEqual([]); // one provider per request
    expect(s.graph.nodeCount).toBe(4);
    expect(s.graph.edgeCount).toBe(3);
    expect(s.lists.get('doi:10.1/s')!.refs).toMatchObject({ status: 'ready', provider: 's2', total: 2, ids: ['doi:10.1/a', 'doi:10.1/b'] });
    expect(s.lists.get('doi:10.1/s')!.cites!.total).toBe(453);
    expect(s.papers.get('doi:10.1/a')!.sources).toEqual({ s2: 'shaA' });
    expect(s.papers.get('doi:10.1/s')!.detailLevel).toBe('list');
    await s.loadList('doi:10.1/s', 'refs');
    expect(s2.calls.filter((c) => c.startsWith('refs')).length).toBe(1);
  });

  it('falls over to OpenAlex when Semantic Scholar is down; records the list provider; merges both sources', async () => {
    s2.fail = new NetworkError('down', 's2');
    const store = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    let s = store.getState();
    expect(s.seeds[0]).toMatchObject({ paperId: 'doi:10.1/s', status: 'ready' });
    expect(s.papers.get('doi:10.1/s')!.sources).toEqual({ openalex: 'WS' });
    expect(s.papers.get('doi:10.1/s')!.influentialCitationCount).toBeNull();
    expect(s.lists.get('doi:10.1/s')!.refs!.provider).toBe('openalex');
    // S2 recovers: details fetched from S2 merge into the same record (both sources, S2 counts win, OA pdf kept)
    s2.fail = null;
    oa.fail = new NetworkError('down', 'openalex');
    await store.getState().refreshSeed('DOI:10.1/s');
    s = store.getState();
    const p = s.papers.get('doi:10.1/s')!;
    expect(p.sources).toEqual({ openalex: 'WS', s2: 'shaS' });
    expect(p.citationCount).toBe(10);
    expect(p.influentialCitationCount).toBe(1);
    expect(p.openAccessPdf?.url).toBe('https://oa/S.pdf');
    expect(p.bibtex).toBe('@x{S}');
  });

  it('loads and caches OpenAlex related works without adding graph edges', async () => {
    const store = make({ settings: { autoExpandSeeds: false } });
    await store.getState().addSeeds(['DOI:10.1/s']);
    const before = store.getState().graph.edgeCount;
    const related = await store.getState().loadList('doi:10.1/s', 'related');
    expect(related).toMatchObject({
      status: 'ready',
      provider: 'openalex',
      ids: ['doi:10.1/c', 'doi:10.1/b'],
      total: 2,
      complete: true,
    });
    expect(s2.calls.some((call) => call.startsWith('related:'))).toBe(false);
    expect(oa.calls).toContain(`related:DOI:10.1/s:${DEFAULT_SETTINGS.listLimit}`);
    expect(store.getState().graph.edgeCount).toBe(before);
    await store.getState().loadList('doi:10.1/s', 'related');
    expect(oa.calls.filter((call) => call.startsWith('related:')).length).toBe(1);
  });

  it('dedupes seeds across id forms and providers', async () => {
    const store = make();
    await store.getState().addSeeds(['DOI:10.1/s', 'doi:10.1/S', 'oa:WS']);
    await settle();
    expect(store.getState().seeds.length).toBe(1);
    expect(store.getState().toasts.some((t) => t.text === 'Already in the map')).toBe(true);
  });

  it('serves seeds and lists from cache on a second store (no network)', async () => {
    await make().getState().addSeeds(['DOI:10.1/s']);
    await settle();
    s2.calls = [];
    oa.calls = [];
    const b = make();
    await b.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    expect(s2.calls).toEqual([]);
    expect(oa.calls).toEqual([]);
    expect(b.getState().seeds[0]!.status).toBe('ready');
    expect(b.getState().graph.nodeCount).toBe(4);
  });

  it('upgrades a cached prefix for a larger list, while a complete short list satisfies any limit', async () => {
    const store = make({ settings: { autoExpandSeeds: false } });
    await store.getState().addSeeds(['DOI:10.1/s']);
    await store.getState().loadList('doi:10.1/s', 'cites', { limit: 25 });
    expect(store.getState().lists.get('doi:10.1/s')!.cites).toMatchObject({ loadedLimit: 25, complete: false });
    await store.getState().loadList('doi:10.1/s', 'cites', { limit: 100 });
    expect(s2.calls.filter((call) => call.startsWith('cites:')).length).toBe(2);
    expect(store.getState().lists.get('doi:10.1/s')!.cites).toMatchObject({ loadedLimit: 100, complete: false });

    await store.getState().addSeeds(['DOI:10.1/a']);
    await store.getState().loadList('doi:10.1/a', 'refs', { limit: 25 });
    const calls = s2.calls.filter((call) => call.startsWith('refs:shaA')).length;
    expect(store.getState().lists.get('doi:10.1/a')!.refs).toMatchObject({ loadedLimit: 25, complete: true });
    await store.getState().loadList('doi:10.1/a', 'refs', { limit: 500 });
    expect(s2.calls.filter((call) => call.startsWith('refs:shaA')).length).toBe(calls);
  });

  it('concurrent list requests converge on the larger result even when the short request finishes last', async () => {
    const store = make({ settings: { autoExpandSeeds: false } });
    await store.getState().addSeeds(['DOI:10.1/s']);
    s2.listDelays.set(25, 20);
    const short = store.getState().loadList('doi:10.1/s', 'cites', { limit: 25 });
    const long = store.getState().loadList('doi:10.1/s', 'cites', { limit: 200 });
    await Promise.all([short, long]);
    expect(store.getState().lists.get('doi:10.1/s')!.cites).toMatchObject({ loadedLimit: 200, complete: false });
    expect(s2.calls.filter((call) => call.startsWith('cites:')).length).toBe(2);
  });

  it('keeps a shared list request alive for one consumer and aborts fully abandoned work without poisoning state', async () => {
    const store = make({ settings: { autoExpandSeeds: false } });
    await store.getState().addSeeds(['DOI:10.1/s']);
    s2.listDelays.set(75, 20);
    const first = new AbortController();
    const second = new AbortController();
    const abandoned = store.getState().loadList('doi:10.1/s', 'cites', { limit: 75, signal: first.signal });
    const survivor = store.getState().loadList('doi:10.1/s', 'cites', { limit: 75, signal: second.signal });
    first.abort();
    expect((await abandoned).status).not.toBe('error');
    expect((await survivor).status).toBe('ready');
    expect(s2.listAborted).toBe(0);
    expect(s2.calls.filter((call) => call.startsWith('cites:')).length).toBe(1);

    s2.listDelays.set(125, 50);
    const only = new AbortController();
    const cancelled = store.getState().loadList('doi:10.1/s', 'cites', { limit: 125, signal: only.signal });
    await new Promise((resolve) => setTimeout(resolve, 1));
    only.abort();
    expect((await cancelled).status).not.toBe('error');
    await settle();
    expect(s2.listAborted).toBe(1);
    expect(store.getState().lists.get('doi:10.1/s')!.cites).toMatchObject({ status: 'ready', loadedLimit: 75 });
    s2.listDelays.delete(125);
    expect((await store.getState().loadList('doi:10.1/s', 'cites', { limit: 125 })).status).toBe('ready');
  });

  it('waits for startup cache adoption once and restores a warm seed without a network request', async () => {
    const startup = new MemoryCache();
    const persistent = new MemoryCache();
    const cached = mk('s2', 'S', 'list');
    cached.paperId = 'doi:10.1/s';
    await persistent.putPapers([cached]);
    await persistent.putLookups([['doi:10.1/s', { paperId: 'doi:10.1/s', fetchedAt: 10 }]]);
    let release!: (cache: CacheAdapter) => void;
    const ready = new Promise<CacheAdapter>((resolve) => (release = resolve));
    const id = new Identity(startup);
    const store = createAppStore({
      router: new Router({ providers: [s2, oa], identity: id, getMode: () => store.getState().settings.sourceMode }),
      identity: id,
      cache: startup,
      settings: { ...DEFAULT_SETTINGS, autoExpandSeeds: false },
      toastMs: 0,
      now: () => 10,
    });
    void store.prepareCache(ready);
    const adding = store.getState().addSeeds(['DOI:10.1/s']);
    expect(store.getState().seeds[0]!.status).toBe('resolving');
    release(persistent);
    await adding;
    expect(store.getState().seeds[0]).toMatchObject({ status: 'ready', paperId: 'doi:10.1/s' });
    expect(s2.calls).toEqual([]);
    expect(oa.calls).toEqual([]);
  });

  it('uses batch for many lookups, falls back per id when a batch fails, records not-found', async () => {
    const store = make();
    await store.getState().addSeeds(['DOI:10.1/s', 'DOI:10.1/a', 'DOI:10.1/b', 'DOI:10.1/zz']);
    await settle();
    expect(s2.calls.filter((c) => c.startsWith('batch')).length).toBe(1);
    const seeds = store.getState().seeds;
    expect(seeds.map((x) => x.status)).toEqual(['ready', 'ready', 'ready', 'error']);
    expect(seeds[3]!.error).toMatch(/Not found/);

    s2.failBatch = new NetworkError('boom', 's2');
    oa.failBatch = new NetworkError('boom', 'openalex');
    const second = make({ cache: new MemoryCache() });
    await second.getState().addSeeds(['DOI:10.1/s', 'DOI:10.1/a', 'DOI:10.1/b']);
    await settle();
    expect(second.getState().seeds.every((x) => x.status === 'ready')).toBe(true);
    // negative cache: a new store does not ask the network again for the unknown DOI
    s2.calls = [];
    const third = make();
    await third.getState().addSeeds(['DOI:10.1/zz']);
    expect(s2.calls).toEqual([]);
    expect(third.getState().seeds[0]!.status).toBe('error');
  });

  it('forced source mode never calls the other provider and reports unsupported ids', async () => {
    const store = make({ settings: { sourceMode: 'openalex' } });
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    expect(s2.calls).toEqual([]);
    expect(store.getState().seeds[0]!.status).toBe('ready');
    await store.getState().addSeeds(['ARXIV:1706.03762']);
    await settle();
    expect(store.getState().seeds[1]).toMatchObject({ status: 'error' });
    expect(store.getState().seeds[1]!.error).toMatch(/OpenAlex cannot look up/);
    store.getState().updateSettings({ sourceMode: 's2' });
    await store.getState().addSeeds(['DOI:10.1/a']);
    await settle();
    expect(oa.calls.filter((c) => c.includes('10.1/a'))).toEqual([]);
    expect(store.getState().seeds[2]!.status).toBe('ready');
  });

  it('expandNode promotes to seed; removeSeed rebuilds; refresh re-fetches lists', async () => {
    const store = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    await store.getState().expandNode('doi:10.1/a');
    let g = store.getState().graph;
    expect(g.edges.has('doi:10.1/a>doi:10.1/b')).toBe(true);
    expect(g.getNode('doi:10.1/a')!.seed).toBe(true);
    expect(store.getState().seeds.map((x) => x.lookup)).toEqual(['DOI:10.1/s', 'doi:10.1/a']);
    store.getState().removeSeed('DOI:10.1/s');
    g = store.getState().graph;
    expect([...g.nodes.keys()].sort()).toEqual(['doi:10.1/a', 'doi:10.1/b']);
    LISTS.A!.refs = ['C'];
    await store.getState().refreshSeed('doi:10.1/a');
    expect(store.getState().lists.get('doi:10.1/a')!.refs!.ids).toEqual(['doi:10.1/c']);
    expect([...store.getState().graph.nodes.keys()].sort()).toEqual(['doi:10.1/a', 'doi:10.1/c']);
    LISTS.A!.refs = ['B'];
  });

  it('search, ensureDetail, selectByKey, settings', async () => {
    const store = make();
    await store.getState().searchPapers('graph');
    expect(store.getState().search).toMatchObject({ status: 'ready', ids: ['doi:10.1/a', 'doi:10.1/b'], total: 2, provider: 's2' });
    expect(store.getState().papers.get('doi:10.1/a')!.detailLevel).toBe('list');
    await store.getState().ensureDetail('doi:10.1/a');
    expect(store.getState().papers.get('doi:10.1/a')!.detailLevel).toBe('full');
    expect(store.getState().papers.get('doi:10.1/a')!.abstract).toBe('Abstract A');
    const n = s2.calls.length;
    await store.getState().ensureDetail('doi:10.1/a');
    expect(s2.calls.length).toBe(n);
    await store.getState().selectByKey('DOI:10.1/A');
    expect(store.getState().selectedId).toBe('doi:10.1/a');
    await store.getState().selectByKey('unknown');
    expect(store.getState().selectedId).toBe('unknown');

    const before = s2.queue.options.concurrency;
    store.getState().updateSettings({ apiKey: 'k', listLimit: 99999, openalexEmail: ' me@x.org ' });
    expect(s2.queue.options.concurrency).toBeGreaterThan(before);
    expect(store.getState().settings.listLimit).toBe(1000);
    expect(store.getState().settings.openalexEmail).toBe('me@x.org');
    expect(new UnsupportedLookupError('x', 'openalex').message).toMatch(/OpenAlex/);
  });

  it('tracks selection history with browser-style back and forward navigation', () => {
    const store = make({ settings: { autoExpandSeeds: false } });
    const state = () => store.getState();
    state().select('doi:10.1/a');
    state().select('doi:10.1/b');
    state().select('doi:10.1/c');
    expect(state()).toMatchObject({
      selectedId: 'doi:10.1/c',
      selectionHistory: ['doi:10.1/a', 'doi:10.1/b', 'doi:10.1/c'],
      selectionIndex: 2,
    });

    state().selectPrevious();
    state().selectPrevious();
    expect(state()).toMatchObject({ selectedId: 'doi:10.1/a', selectionIndex: 0 });
    state().selectNext();
    expect(state()).toMatchObject({ selectedId: 'doi:10.1/b', selectionIndex: 1 });

    // A new selection after going back replaces the old forward branch.
    state().select('doi:10.1/a');
    expect(state()).toMatchObject({
      selectedId: 'doi:10.1/a',
      selectionHistory: ['doi:10.1/a', 'doi:10.1/b', 'doi:10.1/a'],
      selectionIndex: 2,
    });
    state().selectNext();
    expect(state()).toMatchObject({ selectedId: 'doi:10.1/a', selectionIndex: 2 });

    // Closing and reopening the current selection does not add a duplicate visit.
    state().select(null);
    state().select('doi:10.1/a');
    expect(state().selectionHistory).toEqual(['doi:10.1/a', 'doi:10.1/b', 'doi:10.1/a']);
  });
});
