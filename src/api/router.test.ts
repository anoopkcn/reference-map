import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Identity, type AliasEntry, type AliasStore } from '../lib/identity';
import type { DetailLevel, ListKind, Lookup, Paper, ProviderId, SourceMode } from '../types';
import { NetworkError, NotFoundError, UnsupportedLookupError } from './errors';
import { ProviderStats, type ListResult, type Provider, type SearchResult } from './provider';
import { RequestQueue, type EnqueueOptions } from './queue';
import { Router } from './router';

class MemStore implements AliasStore {
  m = new Map<string, AliasEntry>();
  async getLookups(keys: readonly string[]) {
    const out = new Map<string, AliasEntry>();
    for (const k of keys) if (this.m.has(k)) out.set(k, this.m.get(k)!);
    return out;
  }
  async putLookup(key: string, v: AliasEntry) {
    this.m.set(key, v);
  }
  async putLookups(entries: readonly (readonly [string, AliasEntry])[]) {
    for (const [key, v] of entries) this.m.set(key, v);
  }
}

const mk = (id: ProviderId, native: string, doi?: string): Paper => ({
  paperId: `${id === 's2' ? 's2' : 'oa'}:${native}`,
  sources: id === 's2' ? { s2: native } : { openalex: native },
  title: `Paper ${native}`,
  year: 2020,
  authors: [],
  venue: '',
  journal: null,
  citationCount: 1,
  referenceCount: 1,
  influentialCitationCount: id === 's2' ? 0 : null,
  externalIds: doi ? { DOI: doi } : {},
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: [],
  publicationDate: null,
  detailLevel: 'list',
  fetchedAt: 0,
});

/** Fake provider: capability by prefix; behaviour configurable per test. */
class Fake implements Provider {
  readonly queue = new RequestQueue({ concurrency: 4, minIntervalMs: 0 });
  readonly stats = new ProviderStats(() => Date.now());
  calls: string[] = [];
  delayMs = 0;
  fail: unknown = null;
  aborted = 0;
  constructor(
    readonly id: ProviderId,
    private accept: RegExp,
  ) {}
  toNative(lookup: Lookup) {
    return this.accept.test(lookup) ? lookup : null;
  }
  lookupFor(p: Pick<Paper, 'sources' | 'externalIds'>) {
    return (this.id === 's2' ? p.sources.s2 : p.sources.openalex) ?? (p.externalIds.DOI ? `DOI:${p.externalIds.DOI}` : null);
  }
  /** Like a real client: records latency on success and errors on failure in its own stats. */
  private async go<T>(label: string, make: () => T, o?: EnqueueOptions): Promise<T> {
    this.calls.push(label);
    const signal = o?.signal;
    const op = label.split(':')[0] === 'paper' ? 'detail' : (label.split(':')[0] as 'resolve' | 'refs' | 'cites' | 'batch' | 'search');
    if (this.delayMs > 0) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, this.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          this.aborted++;
          rej(new DOMException('x', 'AbortError'));
        });
      });
    }
    if (this.fail) {
      this.stats.record(op, false, this.delayMs, this.fail);
      throw this.fail;
    }
    this.stats.record(op, true, this.delayMs);
    return make();
  }
  resolve(lookup: Lookup, _level: DetailLevel, o?: EnqueueOptions) {
    return this.go(`resolve:${lookup}`, () => mk(this.id, lookup.replace(/^DOI:/, ''), lookup.startsWith('DOI:') ? lookup.slice(4) : undefined), o);
  }
  getPaper(native: string, _level: DetailLevel, o?: EnqueueOptions) {
    return this.go(`paper:${native}`, () => mk(this.id, native), o);
  }
  getList(native: string, kind: ListKind, _limit: number, o?: EnqueueOptions): Promise<ListResult> {
    return this.go(`${kind}:${native}`, () => {
      const papers = [mk(this.id, `${native}-a`, '10.1/shared'), mk(this.id, `${native}-b`)];
      return { ids: papers.map((p) => p.paperId), papers, hasMore: false, total: 2 };
    }, o);
  }
  getBatch(lookups: readonly Lookup[], _level: DetailLevel, o?: EnqueueOptions) {
    return this.go(`batch:${lookups.join(',')}`, () => lookups.map((l) => (this.toNative(l) && !l.includes('missing') ? mk(this.id, l, l.startsWith('DOI:') ? l.slice(4) : undefined) : null)), o);
  }
  search(query: string, _limit: number, o?: EnqueueOptions): Promise<SearchResult> {
    return this.go(`search:${query}`, () => ({ papers: [mk(this.id, 'hit')], total: 1 }), o);
  }
}

describe('Router', () => {
  let s2: Fake;
  let oa: Fake;
  let mode: SourceMode;
  const make = (soft = 4000) => new Router({ providers: [s2, oa], identity: new Identity(new MemStore()), getMode: () => mode, softTimeoutMs: soft });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    s2 = new Fake('s2', /^(DOI:|ARXIV:|s2:|[0-9a-f]{40}$)/);
    oa = new Fake('openalex', /^(DOI:|oa:|PMID:)/);
    mode = 'auto';
  });
  afterEach(() => vi.useRealTimers());

  it('routes by capability and canonicalises ids', async () => {
    const r = make();
    const a = await r.resolve('ARXIV:1', 'list');
    expect(s2.calls).toEqual(['resolve:ARXIV:1']);
    expect(oa.calls).toEqual([]);
    expect(a.paperId).toBe('s2:arxiv:1');
    const b = await r.resolve('oa:W1', 'list');
    expect(oa.calls).toEqual(['resolve:oa:W1']);
    expect(b.paperId).toBe('oa:OA:W1');
    const c = await r.resolve('DOI:10.1/x', 'list');
    expect(c.paperId).toBe('doi:10.1/x'); // canonical DOI id
    expect(s2.calls.length + oa.calls.length).toBe(3); // one provider per request
    await expect(r.resolve('nonsense', 'list')).rejects.toBeInstanceOf(UnsupportedLookupError);
  });

  it('forced modes never call the other provider', async () => {
    mode = 'openalex';
    const r = make();
    await r.resolve('DOI:10.1/x', 'list');
    expect(s2.calls).toEqual([]);
    expect(oa.calls).toEqual(['resolve:DOI:10.1/x']);
    await expect(r.resolve('ARXIV:1', 'list')).rejects.toBeInstanceOf(UnsupportedLookupError);
    mode = 's2';
    await r.resolve('DOI:10.1/y', 'list');
    expect(oa.calls.length).toBe(1);
  });

  it('falls back on errors; NotFound only when every capable provider misses', async () => {
    const r = make();
    s2.fail = new NetworkError('down', 's2');
    const p = await r.resolve('DOI:10.1/x', 'list');
    expect(p.sources.openalex).toBeDefined();
    expect(s2.calls.length).toBe(1);
    expect(oa.calls.length).toBe(1);
    // after an S2 error, OpenAlex is preferred for the next request
    s2.fail = null;
    await r.resolve('DOI:10.1/y', 'list');
    expect(oa.calls.length).toBe(2);
    expect(s2.calls.length).toBe(1);
    s2.fail = new NotFoundError('nf', undefined, 's2');
    oa.fail = new NotFoundError('nf', undefined, 'openalex');
    await expect(r.resolve('DOI:10.1/z', 'list')).rejects.toBeInstanceOf(NotFoundError);
    oa.fail = null;
    // a 404 on one side still returns the other's answer
    const q = await r.resolve('DOI:10.1/w', 'list');
    expect(q.sources.openalex).toBeDefined();
  });

  it('hedges after the soft timeout, takes the first answer and aborts the loser; no hedge when fast', async () => {
    const r = make(4000);
    s2.delayMs = 500;
    const fast = r.resolve('DOI:10.1/fast', 'list');
    await vi.advanceTimersByTimeAsync(600);
    expect(await fast).toBeTruthy();
    expect(oa.calls).toEqual([]);

    oa.stats.record('resolve', true, 1000); // keep S2 as the known-faster resolve provider for the hedge scenario
    s2.delayMs = 10_000;
    oa.delayMs = 300;
    const slow = r.resolve('DOI:10.1/slow', 'list');
    await vi.advanceTimersByTimeAsync(3999);
    expect(oa.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(oa.calls).toEqual(['resolve:DOI:10.1/slow']);
    await vi.advanceTimersByTimeAsync(300);
    const p = await slow;
    expect(p.sources.openalex).toBeDefined();
    expect(s2.aborted).toBe(1);
  });

  it('getList tags the provider, drops self, dedupes and canonicalises; shared DOI maps to one id across providers', async () => {
    const r = make();
    const seed = mk('s2', 'S');
    const l1 = await r.getList(seed, 'refs', 10);
    expect(l1.provider).toBe('s2');
    expect(l1.ids).toEqual(['doi:10.1/shared', 's2:s-b']);
    mode = 'openalex';
    const oaSeed = { ...mk('openalex', 'W1'), externalIds: {} };
    const l2 = await r.getList(oaSeed, 'cites', 10);
    expect(l2.provider).toBe('openalex');
    expect(l2.ids[0]).toBe('doi:10.1/shared'); // same canonical id as the S2 record
  });

  it('uses operation-specific latency history when choosing a provider', async () => {
    const r = make();
    s2.stats.record('detail', true, 10);
    oa.stats.record('detail', true, 5000);
    s2.stats.record('refs', true, 5000);
    oa.stats.record('refs', true, 10);
    const seed = { ...mk('s2', 'S', '10.1/s'), sources: { s2: 'S', openalex: 'W1' } };
    await r.getList(seed, 'refs', 10);
    expect(oa.calls.some((call) => call.startsWith('refs:'))).toBe(true);
    await r.getPaper(seed, 'list');
    expect(s2.calls.some((call) => call.startsWith('paper:'))).toBe(true);
  });

  it('getBatch partitions by capability and retries misses on the other provider', async () => {
    const r = make();
    const res = await r.getBatch(['ARXIV:1', 'oa:W2', 'DOI:10.1/a', 'PMID:missing', 'nonsense'], 'list');
    expect(res.map((p) => p?.paperId ?? null)).toEqual(['s2:arxiv:1', 'oa:OA:W2', 'doi:10.1/a', null, null]);
    expect(s2.calls.filter((c) => c.startsWith('batch')).length).toBe(1);
    expect(oa.calls.filter((c) => c.startsWith('batch')).length).toBe(1);
    // S2 fails → DOI lookups fall through to OpenAlex
    s2.fail = new NetworkError();
    const res2 = await r.getBatch(['DOI:10.1/b', 'ARXIV:2'], 'list');
    expect(res2[0]?.sources.openalex).toBeDefined();
    expect(res2[1]).toBeNull();
  });

  it('status reports per-provider health', async () => {
    const r = make();
    s2.fail = new NetworkError();
    await r.resolve('DOI:10.1/x', 'list');
    const st = r.status();
    expect(st.s2.recentErrors).toBe(1);
    expect(st.s2.lastError).toMatch(/Could not reach/);
    expect(st.openalex.recentErrors).toBe(0);
    expect(st.s2.score).toBeGreaterThan(st.openalex.score);
  });
});
