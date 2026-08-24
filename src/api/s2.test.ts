import { describe, expect, it } from 'vitest';
import { NetworkError, NotFoundError, RateLimitedError } from './errors';
import { hasUnicodeReplacement, mergePaper, normalizePaper, repairUnicodeMetadata } from './normalize';
import { RequestQueue } from './queue';
import { S2Client, parseRetryAfter } from './s2';

const raw = {
  paperId: 'abc',
  title: ' Attention Is All You Need ',
  year: 2017,
  authors: [{ authorId: '1', name: 'Ashish Vaswani' }, { authorId: null, name: null }],
  venue: 'NeurIPS',
  journal: { name: null, volume: null, pages: '5998-6008' },
  citationCount: 1,
  externalIds: { DOI: '10.1/x', CorpusId: 13756489, ArXiv: '1706.03762', Nope: 'x' },
  isOpenAccess: true,
  openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762', status: 'GREEN' },
  publicationTypes: null,
  abstract: 'The dominant…',
  citationStyles: { bibtex: '@article{…}' },
};

describe('normalizePaper / mergePaper', () => {
  it('normalizes a raw record at list level', () => {
    const p = normalizePaper(raw, 'list', 5)!;
    expect(p.paperId).toBe('s2:abc');
    expect(p.sources).toEqual({ s2: 'abc' });
    expect(p.title).toBe('Attention Is All You Need');
    expect(p.authors).toEqual([{ authorId: '1', name: 'Ashish Vaswani', provider: 's2' }]);
    expect(p.journal).toEqual({ pages: '5998-6008' });
    expect(p.externalIds).toEqual({ DOI: '10.1/x', CorpusId: '13756489', ArXiv: '1706.03762' });
    expect(p.openAccessPdf).toEqual({ url: 'https://arxiv.org/pdf/1706.03762', status: 'GREEN' });
    expect(p.publicationTypes).toEqual([]);
    expect(p.referenceCount).toBe(0);
    expect(p.abstract).toBeUndefined();
    expect(p.detailLevel).toBe('list');
    expect(p.fetchedAt).toBe(5);
  });
  it('keeps abstract/bibtex at full level and drops records without paperId', () => {
    const p = normalizePaper(raw, 'full')!;
    expect(p.abstract).toBe('The dominant…');
    expect(p.bibtex).toBe('@article{…}');
    expect(normalizePaper({ ...raw, paperId: null }, 'list')).toBeNull();
    expect(normalizePaper(null, 'list')).toBeNull();
  });
  it('preserves non-Latin and right-to-left metadata', () => {
    const p = normalizePaper({
      ...raw,
      title: '注意力だけで十分である',
      authors: [{ authorId: '2', name: '李 雷' }, { authorId: '3', name: 'أحمد محمد' }],
      venue: 'ニューラル情報処理システム会議',
      abstract: 'هذه خلاصة باللغة العربية.',
    }, 'full')!;
    expect(p.title).toBe('注意力だけで十分である');
    expect(p.authors.map((author) => author.name)).toEqual(['李 雷', 'أحمد محمد']);
    expect(p.venue).toBe('ニューラル情報処理システム会議');
    expect(p.abstract).toBe('هذه خلاصة باللغة العربية.');
  });
  it('repairs only Unicode replacement damage using clean fallback metadata', () => {
    const primary = {
      ...normalizePaper(raw, 'list', 1)!,
      sources: { openalex: 'W1' },
      title: 'Prim\uFFFDrzerlegung in Steinschen Algebren',
      authors: [{ authorId: 'A1', name: 'J\uFFFDrgen Neukirch', provider: 'openalex' as const }],
      venue: 'Mathematische Annalen',
      citationCount: 30,
      externalIds: { DOI: '10.1007/example', MAG: '1' },
    };
    const fallback = {
      ...normalizePaper(raw, 'list', 2)!,
      title: 'Primärzerlegung in Steinschen Algebren',
      authors: [{ authorId: 'S1', name: 'Jürgen Neukirch', provider: 's2' as const }],
      venue: '',
      externalIds: { DOI: '10.1007/example', CorpusId: '2' },
    };
    expect(hasUnicodeReplacement(primary)).toBe(true);
    const repaired = repairUnicodeMetadata(primary, fallback);
    expect(repaired.title).toBe('Primärzerlegung in Steinschen Algebren');
    expect(repaired.authors).toEqual([{ authorId: 'A1', name: 'Jürgen Neukirch', provider: 'openalex' }]);
    expect(repaired.venue).toBe('Mathematische Annalen');
    expect(repaired.citationCount).toBe(30);
    expect(repaired.sources).toEqual({ openalex: 'W1', s2: 'abc' });
    expect(repaired.externalIds).toEqual({ DOI: '10.1007/example', MAG: '1', CorpusId: '2' });
    expect(hasUnicodeReplacement(repaired)).toBe(false);
  });
  it('merge never downgrades detail', () => {
    const full = normalizePaper(raw, 'full', 1)!;
    const list = normalizePaper({ ...raw, citationCount: 99 }, 'list', 2)!;
    const m = mergePaper(full, list);
    expect(m.citationCount).toBe(99);
    expect(m.detailLevel).toBe('full');
    expect(m.abstract).toBe('The dominant…');
    expect(m.bibtex).toBe('@article{…}');
    expect(mergePaper(list, full).abstract).toBe('The dominant…');
    expect(mergePaper(undefined, list)).toBe(list);
  });
  it('merge across providers: keeps the canonical id, unions ids, S2 wins for counts, OpenAlex fills blanks', () => {
    const s2 = { ...normalizePaper(raw, 'list', 1)!, paperId: 'doi:10.1/x', venue: '', openAccessPdf: null };
    const oa = {
      ...s2,
      paperId: 'doi:10.1/x',
      sources: { openalex: 'W1' },
      citationCount: 5,
      influentialCitationCount: null,
      venue: 'NeurIPS (OA)',
      openAccessPdf: { url: 'https://oa.example/pdf' },
      externalIds: { DOI: '10.1/x', MAG: '77' },
      fetchedAt: 9,
      detailLevel: 'full' as const,
      abstract: 'From OpenAlex',
      bibtex: null,
    };
    const m1 = mergePaper(s2, oa);
    expect(m1.paperId).toBe('doi:10.1/x');
    expect(m1.sources).toEqual({ s2: 'abc', openalex: 'W1' });
    expect(m1.citationCount).toBe(1); // S2 wins
    expect(m1.influentialCitationCount).toBe(0);
    expect(m1.venue).toBe('NeurIPS (OA)'); // blank filled
    expect(m1.openAccessPdf?.url).toBe('https://oa.example/pdf');
    expect(m1.externalIds).toEqual({ DOI: '10.1/x', CorpusId: '13756489', ArXiv: '1706.03762', MAG: '77' });
    expect(m1.abstract).toBe('From OpenAlex');
    expect(m1.detailLevel).toBe('full');
    expect(m1.fetchedAt).toBe(9);
    // reverse arrival order gives the same answer for the S2-owned fields
    const m2 = mergePaper(oa, s2);
    expect(m2.citationCount).toBe(1);
    expect(m2.influentialCitationCount).toBe(0);
    expect(m2.venue).toBe('NeurIPS (OA)');
    expect(m2.sources).toEqual({ openalex: 'W1', s2: 'abc' });
    // OA-only merge keeps influential unknown
    const oa2 = { ...oa, citationCount: 6 };
    expect(mergePaper(oa, oa2).influentialCitationCount).toBeNull();
    expect(mergePaper(oa, oa2).citationCount).toBe(6);
  });
});

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('S2Client', () => {
  const queue = () => new RequestQueue({ concurrency: 4, minIntervalMs: 0 });

  it('getPaper builds the URL, sends the api key and normalizes', async () => {
    const f = mockFetch(() => ({ body: raw }));
    const c = new S2Client({ queue: queue(), fetchFn: f.fn, getApiKey: () => 'KEY' });
    const p = await c.getPaper('DOI:10.1/x', 'full');
    expect(p.paperId).toBe('s2:abc');
    expect(f.calls[0]!.url).toBe('https://api.semanticscholar.org/graph/v1/paper/DOI%3A10.1%2Fx?fields=' + encodeURIComponentLite(fieldsFull()));
    expect(new Headers(f.calls[0]!.init!.headers).get('x-api-key')).toBe('KEY');
  });

  it('getPaper maps 404 / 429', async () => {
    const f = mockFetch((u) => (u.includes('missing') ? { status: 404, body: { error: 'x' } } : { status: 429, headers: { 'retry-after': '1' } }));
    const c = new S2Client({ queue: new RequestQueue({ concurrency: 1, minIntervalMs: 0, maxRetries: 0, maxRateLimitRetries: 0 }), fetchFn: f.fn });
    await expect(c.getPaper('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.getPaper('limited')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('treats an opaque fetch failure as a rate limit while online, as a network error while offline', async () => {
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    const q = () => new RequestQueue({ concurrency: 1, minIntervalMs: 0, maxRetries: 0, maxRateLimitRetries: 0 });
    // The public pool omits CORS headers on 429s, so the browser reports them as fetch failures.
    const online = new S2Client({ queue: q(), fetchFn: failing, onLine: () => true });
    await expect(online.getPaper('abc')).rejects.toBeInstanceOf(RateLimitedError);
    const offline = new S2Client({ queue: q(), fetchFn: failing, onLine: () => false });
    await expect(offline.getPaper('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('getList drops null citedPaper rows, dedupes and reports hasMore', async () => {
    const f = mockFetch(() => ({
      body: {
        next: 500,
        data: [{ citedPaper: raw }, { citedPaper: { paperId: null, title: 'Unresolved' } }, { citedPaper: raw }, { citedPaper: { ...raw, paperId: 'def' } }],
      },
    }));
    const c = new S2Client({ queue: queue(), fetchFn: f.fn });
    const r = await c.getList('abc', 'refs', 500);
    expect(r.ids).toEqual(['s2:abc', 's2:def']);
    expect(r.papers.map((p) => p.paperId)).toEqual(['s2:abc', 's2:def']);
    expect(r.total).toBeNull();
    expect(r.hasMore).toBe(true);
    expect(f.calls[0]!.url).toContain('/paper/abc/references?limit=500&fields=');
    const r2 = await c.getList('abc', 'cites', 5000);
    expect(f.calls[1]!.url).toContain('/paper/abc/citations?limit=1000&');
    expect(r2.ids).toEqual([]); // citingPaper field missing in mock → all dropped
  });

  it('getBatch posts ids and aligns results', async () => {
    const f = mockFetch(() => ({ body: [raw, null] }));
    const c = new S2Client({ queue: queue(), fetchFn: f.fn });
    const r = await c.getBatch(['DOI:10.1/x', 'DOI:10.2/y']);
    expect(r[0]!.paperId).toBe('s2:abc');
    expect(r[1]).toBeNull();
    expect(f.calls[0]!.init!.method).toBe('POST');
    expect(JSON.parse(f.calls[0]!.init!.body as string)).toEqual({ ids: ['DOI:10.1/x', 'DOI:10.2/y'] });
    expect(await c.getBatch([])).toEqual([]);
  });

  it('search', async () => {
    const f = mockFetch(() => ({ body: { total: 1234, data: [raw] } }));
    const c = new S2Client({ queue: queue(), fetchFn: f.fn });
    const r = await c.search('attention is all you need', 10);
    expect(r.total).toBe(1234);
    expect(r.papers[0]!.paperId).toBe('s2:abc');
    expect(f.calls[0]!.url).toContain('/paper/search?query=attention%20is%20all%20you%20need&limit=10&');
  });

  it('parseRetryAfter', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('garbage')).toBeNull();
    const now = Date.parse('2024-01-01T00:00:00Z');
    expect(parseRetryAfter('Mon, 01 Jan 2024 00:00:10 GMT', now)).toBe(10_000);
  });
});

function fieldsFull() {
  return 'paperId,title,year,authors,venue,journal,citationCount,referenceCount,influentialCitationCount,externalIds,isOpenAccess,openAccessPdf,publicationTypes,publicationDate,abstract,citationStyles';
}
function encodeURIComponentLite(s: string) {
  return s; // field list contains only URL-safe characters
}
