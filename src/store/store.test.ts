import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../api/cache';
import { NotFoundError, NetworkError } from '../api/errors';
import { RequestQueue } from '../api/queue';
import type { S2Client } from '../api/s2';
import { DEFAULT_SETTINGS, type Paper } from '../types';
import { createAppStore } from './store';

const mk = (id: string, over: Partial<Paper> = {}): Paper => ({
  paperId: id,
  title: `Paper ${id}`,
  year: 2020,
  authors: [{ authorId: null, name: `Auth ${id}` }],
  venue: '',
  journal: null,
  citationCount: 1,
  referenceCount: 2,
  influentialCitationCount: 0,
  externalIds: {},
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: [],
  publicationDate: null,
  detailLevel: 'full',
  fetchedAt: 1,
  ...over,
});

function makeClient() {
  const papers = new Map<string, Paper>([['S', mk('S')], ['A', mk('A', { detailLevel: 'list' })], ['B', mk('B', { detailLevel: 'list' })], ['C', mk('C', { detailLevel: 'list' })]]);
  const lookups = new Map<string, string>([['DOI:10.1/s', 'S'], ['ARXIV:1', 'S'], ['DOI:10.1/a', 'A'], ['DOI:10.1/b', 'B']]);
  const client = {
    getPaper: vi.fn(async (lookup: string, level: string) => {
      const id = lookups.get(lookup) ?? (papers.has(lookup) ? lookup : null);
      if (!id) throw new NotFoundError();
      return { ...papers.get(id)!, detailLevel: level };
    }),
    getList: vi.fn(async (id: string, kind: string) => {
      if (id === 'S' && kind === 'refs') return { ids: ['A', 'B'], papers: [papers.get('A')!, papers.get('B')!], hasMore: false };
      if (id === 'S' && kind === 'cites') return { ids: ['C'], papers: [papers.get('C')!], hasMore: true };
      if (id === 'A' && kind === 'refs') return { ids: ['B'], papers: [papers.get('B')!], hasMore: false };
      return { ids: [], papers: [], hasMore: false };
    }),
    getBatch: vi.fn(async (ls: string[]) => ls.map((l) => (lookups.get(l) ? papers.get(lookups.get(l)!)! : null))),
    search: vi.fn(async () => ({ papers: [papers.get('A')!, papers.get('B')!], total: 2 })),
  };
  return { client: client as unknown as S2Client, mocks: client };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('store', () => {
  let cache: MemoryCache;
  beforeEach(() => {
    cache = new MemoryCache();
  });

  const make = (over: Partial<Parameters<typeof createAppStore>[0]> = {}) => {
    const { client, mocks } = makeClient();
    const store = createAppStore({ client, queue: new RequestQueue({ concurrency: 4, minIntervalMs: 0 }), cache, settings: DEFAULT_SETTINGS, toastMs: 0, now: () => 10, ...over });
    return { store, mocks };
  };

  it('addSeeds resolves, adds to graph and auto-expands (lazy lists reused by graph)', async () => {
    const { store, mocks } = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    const s = store.getState();
    expect(s.seeds).toEqual([{ lookup: 'DOI:10.1/s', paperId: 'S', status: 'ready', error: undefined }]);
    expect(mocks.getPaper).toHaveBeenCalledTimes(1);
    expect(mocks.getPaper).toHaveBeenCalledWith('DOI:10.1/s', 'full', expect.anything());
    expect(mocks.getList).toHaveBeenCalledTimes(2);
    expect(s.graph.nodeCount).toBe(4);
    expect(s.graph.edgeCount).toBe(3);
    expect(s.lists.get('S')!.refs!.status).toBe('ready');
    expect(s.lists.get('S')!.refs!.total).toBe(2);
    expect(s.expanding.size).toBe(0);
    // opening the list again does not refetch
    await s.loadList('S', 'refs');
    expect(mocks.getList).toHaveBeenCalledTimes(2);
  });

  it('dedupes seeds resolving to the same paper and ignores repeated lookups', async () => {
    const { store } = make();
    await store.getState().addSeeds(['DOI:10.1/s', 'ARXIV:1', 'doi:10.1/S']);
    await settle();
    expect(store.getState().seeds.length).toBe(1);
    expect(store.getState().toasts.some((t) => t.text === 'Already in the map')).toBe(true);
  });

  it('serves seeds from cache on a second store instance (no network)', async () => {
    const a = make();
    await a.store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    const b = make();
    await b.store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    expect(b.mocks.getPaper).not.toHaveBeenCalled();
    expect(b.store.getState().seeds[0]!.status).toBe('ready');
    // lists come from cache too, papers via cache
    expect(b.mocks.getList).not.toHaveBeenCalled();
    expect(b.store.getState().graph.nodeCount).toBe(4);
  });

  it('uses batch for many lookups and falls back to single requests when batch fails', async () => {
    const { store, mocks } = make();
    await store.getState().addSeeds(['DOI:10.1/s', 'DOI:10.1/a', 'DOI:10.1/b', 'DOI:10.1/nope']);
    await settle();
    expect(mocks.getBatch).toHaveBeenCalledTimes(1);
    expect(mocks.getPaper).not.toHaveBeenCalled();
    const seeds = store.getState().seeds;
    expect(seeds.map((s) => s.status)).toEqual(['ready', 'ready', 'ready', 'error']);
    expect(seeds[3]!.error).toMatch(/Not found/);

    const second = make({ cache: new MemoryCache() });
    second.mocks.getBatch.mockRejectedValueOnce(new NetworkError());
    await second.store.getState().addSeeds(['DOI:10.1/s', 'DOI:10.1/a', 'DOI:10.1/b']);
    await settle();
    expect(second.mocks.getPaper).toHaveBeenCalledTimes(3);
    expect(second.store.getState().seeds.every((s) => s.status === 'ready')).toBe(true);
  });

  it('records seed errors instead of swallowing them', async () => {
    const { store } = make();
    await store.getState().addSeeds(['DOI:10.1/missing']);
    await settle();
    expect(store.getState().seeds[0]).toMatchObject({ status: 'error', error: 'Not found on Semantic Scholar' });
    // negative cache
    const again = make();
    await again.store.getState().addSeeds(['DOI:10.1/missing']);
    expect(again.mocks.getPaper).not.toHaveBeenCalled();
    expect(again.store.getState().seeds[0]!.status).toBe('error');
  });

  it('expandNode promotes the node to a seed, merges discovered edges; removeSeed rebuilds the graph', async () => {
    const { store } = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    await store.getState().expandNode('A');
    let g = store.getState().graph;
    expect(g.edges.has('A>B')).toBe(true);
    expect(g.getNode('A')!.expanded).toBe(true);
    expect(g.getNode('A')!.seed).toBe(true);
    expect(store.getState().seeds.map((x) => x.paperId)).toEqual(['S', 'A']);
    // expanding again / adding it again does not duplicate the seed
    await store.getState().expandNode('A');
    await store.getState().addSeeds(['A']);
    expect(store.getState().seeds.length).toBe(2);

    store.getState().select('C');
    store.getState().removeSeed('DOI:10.1/s');
    g = store.getState().graph;
    expect([...g.nodes.keys()].sort()).toEqual(['A', 'B']); // A's neighbourhood survives, S's exclusive nodes are gone
    expect(store.getState().selectedId).toBeNull();
    store.getState().removeSeed('A');
    expect(store.getState().graph.nodeCount).toBe(0);
  });

  it('refreshSeed re-fetches details and lists bypassing caches and rebuilds the graph', async () => {
    const { store, mocks } = make();
    await store.getState().addSeeds(['DOI:10.1/s']);
    await settle();
    expect(mocks.getPaper).toHaveBeenCalledTimes(1);
    expect(mocks.getList).toHaveBeenCalledTimes(2);
    // change what the server returns, then refresh
    mocks.getList.mockImplementation(async (id: string, kind: string) =>
      id === 'S' && kind === 'refs' ? { ids: ['A'], papers: [mk('A', { detailLevel: 'list' })], hasMore: false } : { ids: [], papers: [], hasMore: false },
    );
    await store.getState().refreshSeed('DOI:10.1/s');
    expect(mocks.getPaper).toHaveBeenCalledTimes(2);
    expect(mocks.getPaper).toHaveBeenLastCalledWith('S', 'full', expect.anything());
    expect(mocks.getList).toHaveBeenCalledTimes(4);
    expect(store.getState().lists.get('S')!.refs!.ids).toEqual(['A']);
    expect(store.getState().graph.nodeCount).toBe(2); // S + A (B and C gone)
    expect(store.getState().toasts.some((t) => t.text === 'Paper data refreshed')).toBe(true);
  });

  it('search, ensureDetail, settings', async () => {
    const { store, mocks } = make();
    await store.getState().searchPapers('graph');
    expect(store.getState().search).toMatchObject({ status: 'ready', ids: ['A', 'B'], total: 2 });
    expect(store.getState().papers.get('A')!.detailLevel).toBe('list');
    await store.getState().ensureDetail('A');
    expect(mocks.getPaper).toHaveBeenCalledWith('A', 'full', expect.anything());
    expect(store.getState().papers.get('A')!.detailLevel).toBe('full');
    await store.getState().ensureDetail('A');
    expect(mocks.getPaper).toHaveBeenCalledTimes(1);

    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 1100 });
    const { store: s2 } = make({ queue: q });
    s2.getState().updateSettings({ apiKey: 'k', listLimit: 99999 });
    expect(q.options.concurrency).toBe(2);
    expect(s2.getState().settings.listLimit).toBe(1000);
    s2.getState().updateSettings({ apiKey: '' });
    expect(q.options.concurrency).toBe(1);
  });
});
