import { describe, expect, it } from 'vitest';
import { NotFoundError, RateLimitedError } from './errors';
import { OpenAlexClient, abstractFromInvertedIndex, normalizeOpenAlex, oaTypeToS2, type OAWorkRaw } from './openalex';
import { RequestQueue } from './queue';

const raw: OAWorkRaw = {
  id: 'https://openalex.org/W2801930304',
  doi: 'https://doi.org/10.18653/v1/N18-3011',
  ids: { openalex: 'https://openalex.org/W2801930304', doi: 'https://doi.org/10.18653/v1/n18-3011', mag: '2801930304', pmid: 'https://pubmed.ncbi.nlm.nih.gov/123', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/456' },
  title: 'Construction of the Literature Graph in Semantic Scholar',
  publication_year: 2018,
  publication_date: '2018-06-01',
  cited_by_count: 329,
  referenced_works_count: 31,
  referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
  related_works: ['https://openalex.org/W3', 'https://openalex.org/W4'],
  type: 'article',
  type_crossref: 'proceedings-article',
  biblio: { volume: null, issue: null, first_page: '84', last_page: '91' },
  primary_location: { source: null, landing_page_url: 'https://doi.org/10.18653/v1/n18-3011' },
  best_oa_location: { source: { id: 's1', display_name: 'NAACL' }, pdf_url: 'https://www.aclweb.org/anthology/N18-3011.pdf' },
  open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://www.aclweb.org/anthology/N18-3011.pdf' },
  authorships: [{ author: { id: 'https://openalex.org/A5102948988', display_name: 'Waleed Ammar' } }, { author: { id: null, display_name: 'Dirk Groeneveld' } }, { author: null }],
  abstract_inverted_index: { We: [0], describe: [1], a: [2, 4], graph: [3], thing: [5] },
};

describe('normalizeOpenAlex', () => {
  it('maps ids, authors, venue fallback, pages, types, OA pdf; list level has no abstract', () => {
    const p = normalizeOpenAlex(raw, 'list', 7)!;
    expect(p.paperId).toBe('oa:W2801930304');
    expect(p.sources).toEqual({ openalex: 'W2801930304' });
    expect(p.externalIds).toEqual({ DOI: '10.18653/v1/n18-3011', MAG: '2801930304', PubMed: '123', PubMedCentral: '456' });
    expect(p.authors).toEqual([
      { authorId: 'A5102948988', name: 'Waleed Ammar', provider: 'openalex' },
      { authorId: null, name: 'Dirk Groeneveld', provider: 'openalex' },
    ]);
    expect(p.venue).toBe('NAACL');
    expect(p.journal).toEqual({ name: 'NAACL', pages: '84-91' });
    expect(p.citationCount).toBe(329);
    expect(p.referenceCount).toBe(31);
    expect(p.influentialCitationCount).toBeNull();
    expect(p.publicationTypes).toEqual(['JournalArticle', 'Conference']);
    expect(p.openAccessPdf).toEqual({ url: 'https://www.aclweb.org/anthology/N18-3011.pdf', status: 'gold' });
    expect(p.isOpenAccess).toBe(true);
    expect(p.abstract).toBeUndefined();
    expect(p.fetchedAt).toBe(7);
  });
  it('full level rebuilds the abstract; DataCite arXiv DOI and landing URLs give ArXiv ids', () => {
    const p = normalizeOpenAlex(raw, 'full')!;
    expect(p.abstract).toBe('We describe a graph a thing');
    expect(p.bibtex).toBeNull();
    expect(abstractFromInvertedIndex(null)).toBeNull();
    expect(abstractFromInvertedIndex({})).toBeNull();
    const ax = normalizeOpenAlex({ ...raw, doi: 'https://doi.org/10.48550/arXiv.1706.03762', ids: {} }, 'list')!;
    expect(ax.externalIds).toEqual({ DOI: '10.48550/arxiv.1706.03762', ArXiv: '1706.03762' });
    const landing = normalizeOpenAlex({ ...raw, doi: null, ids: {}, primary_location: { landing_page_url: 'https://arxiv.org/abs/2106.15928v2' } }, 'list')!;
    expect(landing.externalIds).toEqual({ ArXiv: '2106.15928' });
    expect(normalizeOpenAlex({ ...raw, id: null, ids: {} }, 'list')).toBeNull();
    expect(normalizeOpenAlex(null, 'list')).toBeNull();
  });
  it('oaTypeToS2', () => {
    expect(oaTypeToS2('book-chapter')).toEqual(['BookSection']);
    expect(oaTypeToS2('paratext')).toEqual([]);
    expect(oaTypeToS2(null, 'proceedings-article')).toEqual(['Conference']);
  });
});

function mockFetch(handler: (url: URL) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: URL[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fn, calls };
}

const w = (n: number, extra: Partial<OAWorkRaw> = {}): OAWorkRaw => ({ id: `https://openalex.org/W${n}`, title: `W${n}`, cited_by_count: n, ...extra });

describe('OpenAlexClient', () => {
  const queue = () => new RequestQueue({ concurrency: 4, minIntervalMs: 0 });

  it('toNative / lookupFor capabilities', () => {
    const c = new OpenAlexClient({ queue: queue() });
    expect(c.toNative('oa:W12345')).toBe('W12345');
    expect(c.toNative('W12345')).toBe('W12345');
    expect(c.toNative('DOI:10.1/X')).toBe('doi:10.1/x');
    expect(c.toNative('doi:10.48550/arXiv.1706.03762')).toBeNull();
    expect(c.toNative('PMID:12')).toBe('pmid:12');
    expect(c.toNative('ARXIV:1706.03762')).toBeNull();
    expect(c.toNative('CorpusId:1')).toBeNull();
    expect(c.toNative('f6c0e8b4b7c2c0f5c2f1a7a8b9d0e1f2a3b4c5d6')).toBeNull();
    expect(c.lookupFor({ sources: { openalex: 'W1' }, externalIds: { DOI: '10.1/x' } })).toBe('W1');
    expect(c.lookupFor({ sources: {}, externalIds: { DOI: '10.1/X' } })).toBe('doi:10.1/x');
    expect(c.lookupFor({ sources: {}, externalIds: { ArXiv: '1' } })).toBeNull();
  });

  it('getPaper builds the URL with select and mailto; maps 404 / 429', async () => {
    const f = mockFetch((u) => (u.pathname.includes('missing') ? { status: 404 } : u.pathname.includes('limited') ? { status: 429, headers: { 'retry-after': '2' } } : { body: raw }));
    const c = new OpenAlexClient({ queue: new RequestQueue({ concurrency: 1, minIntervalMs: 0, maxRetries: 0 }), fetchFn: f.fn, getMailto: () => 'me@example.org' });
    const p = await c.getPaper('doi:10.18653/v1/n18-3011', 'full');
    expect(p.paperId).toBe('oa:W2801930304');
    expect(f.calls[0]!.pathname).toBe('/works/doi:10.18653/v1/n18-3011');
    expect(f.calls[0]!.searchParams.get('select')).toContain('abstract_inverted_index');
    expect(f.calls[0]!.searchParams.get('mailto')).toBe('me@example.org');
    await expect(c.getPaper('doi:missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.getPaper('doi:limited')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('refs: work ids then chunked metadata (≤50 ids per request), ordered like the work, with total', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `https://openalex.org/W${100 + i}`);
    const f = mockFetch((u) => {
      if (u.pathname === '/works/W1') return { body: { id: 'https://openalex.org/W1', referenced_works: ids } };
      const filter = u.searchParams.get('filter')!;
      const wanted = filter.replace('openalex:', '').split('|');
      return { body: { results: wanted.map((x) => w(Number(x.slice(1)))).reverse() } };
    });
    const c = new OpenAlexClient({ queue: queue(), fetchFn: f.fn });
    const r = await c.getList('W1', 'refs', 55);
    expect(f.calls.length).toBe(3);
    expect(f.calls[1]!.searchParams.get('filter')!.split('|').length).toBe(50);
    expect(f.calls[2]!.searchParams.get('filter')!.split('|').length).toBe(5);
    expect(r.ids.slice(0, 3)).toEqual(['oa:W100', 'oa:W101', 'oa:W102']);
    expect(r.ids.length).toBe(55);
    expect(r.total).toBe(60);
    expect(r.hasMore).toBe(true);
  });

  it('runs independent reference chunks concurrently and preserves input order when they finish out of order', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `https://openalex.org/W${100 + i}`);
    const completed: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/works/W1') return new Response(JSON.stringify({ id: 'https://openalex.org/W1', referenced_works: ids }));
      const filter = url.searchParams.get('filter')!;
      const wanted = filter.replace('openalex:', '').split('|');
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, wanted[0] === 'W100' ? 20 : 1));
      active--;
      completed.push(wanted[0]!);
      return new Response(JSON.stringify({ results: wanted.map((id) => w(Number(id.slice(1)))).reverse() }));
    }) as typeof fetch;
    const c = new OpenAlexClient({ queue: new RequestQueue({ concurrency: 2, minIntervalMs: 0 }), fetchFn });
    const result = await c.getList('W1', 'refs', 60);
    expect(maxActive).toBe(2);
    expect(completed).toEqual(['W150', 'W100']);
    expect(result.ids[0]).toBe('oa:W100');
    expect(result.ids.at(-1)).toBe('oa:W159');
  });

  it('related: fetches related_works metadata in OpenAlex order', async () => {
    const f = mockFetch((u) => {
      if (u.pathname === '/works/W1') {
        expect(u.searchParams.get('select')).toBe('id,related_works');
        return { body: { id: 'https://openalex.org/W1', related_works: ['https://openalex.org/W3', 'https://openalex.org/W4'] } };
      }
      const wanted = u.searchParams.get('filter')!.replace('openalex:', '').split('|');
      return { body: { results: wanted.map((id) => w(Number(id.slice(1)))).reverse() } };
    });
    const c = new OpenAlexClient({ queue: queue(), fetchFn: f.fn });
    const r = await c.getList('W1', 'related', 20);
    expect(r.ids).toEqual(['oa:W3', 'oa:W4']);
    expect(r.total).toBe(2);
    expect(r.hasMore).toBe(false);
  });

  it('cites: cursor paging sorted by citations, stops at limit, reports total', async () => {
    const f = mockFetch((u) => {
      const cursor = u.searchParams.get('cursor');
      if (cursor === '*') return { body: { meta: { count: 500, next_cursor: 'c2' }, results: [w(9), w(8)] } };
      return { body: { meta: { count: 500, next_cursor: 'c3' }, results: [w(7)] } };
    });
    const c = new OpenAlexClient({ queue: queue(), fetchFn: f.fn });
    const r = await c.getList('W1', 'cites', 3);
    expect(f.calls.length).toBe(2);
    expect(f.calls[0]!.searchParams.get('filter')).toBe('cites:W1');
    expect(f.calls[0]!.searchParams.get('sort')).toBe('cited_by_count:desc');
    expect(f.calls[0]!.searchParams.get('per-page')).toBe('3');
    expect(f.calls[1]!.searchParams.get('per-page')).toBe('1');
    expect(r.ids).toEqual(['oa:W9', 'oa:W8', 'oa:W7']);
    expect(r.total).toBe(500);
    expect(r.hasMore).toBe(true);
  });

  it('getBatch groups by id kind, aligns results and leaves misses/unsupported null', async () => {
    const f = mockFetch((u) => {
      const filter = u.searchParams.get('filter')!;
      if (filter.startsWith('doi:')) return { body: { results: [w(5, { doi: 'https://doi.org/10.1/B' })] } };
      return { body: { results: [w(7)] } };
    });
    const c = new OpenAlexClient({ queue: queue(), fetchFn: f.fn });
    const r = await c.getBatch(['DOI:10.1/a', 'DOI:10.1/b', 'ARXIV:1', 'oa:W7', 'oa:W8']);
    expect(r.map((p) => p?.paperId ?? null)).toEqual([null, 'oa:W5', null, 'oa:W7', null]);
    expect(f.calls.length).toBe(2);
  });

  it('search', async () => {
    const f = mockFetch(() => ({ body: { meta: { count: 42 }, results: [w(1)] } }));
    const c = new OpenAlexClient({ queue: queue(), fetchFn: f.fn });
    const r = await c.search('attention', 5);
    expect(r.total).toBe(42);
    expect(r.papers[0]!.paperId).toBe('oa:W1');
    expect(f.calls[0]!.searchParams.get('search')).toBe('attention');
  });
});
