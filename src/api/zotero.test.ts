import { describe, expect, it } from 'vitest';
import type { Paper } from '../types';
import { ApiError, RateLimitedError, describeError } from './errors';
import { RequestQueue } from './queue';
import { ZoteroClient, ZoteroConnectorClient, lookupFromZoteroItem, makeWriteToken, paperToConnectorItem, paperToZoteroItem, pdfCandidateUrl, type ZoteroItem } from './zotero';

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

const queue = () => new RequestQueue({ concurrency: 4, minIntervalMs: 0 });
const client = (fn: typeof fetch, key = 'ZKEY') => new ZoteroClient({ queue: queue(), fetchFn: fn, getApiKey: () => key });

const keyBody = { key: 'ZKEY', userID: 12345, username: 'anoop', access: { user: { library: true, write: true } } };

function zItem(data: Partial<ZoteroItem['data']>, meta?: ZoteroItem['meta']): ZoteroItem {
  return { key: 'ITEM1234', version: 1, data: { itemType: 'journalArticle', ...data }, meta };
}

describe('ZoteroClient', () => {
  it('keyInfo hits /keys/current with auth headers and parses the response', async () => {
    const f = mockFetch(() => ({ body: keyBody }));
    const info = await client(f.fn).keyInfo();
    expect(info).toEqual({ userID: 12345, username: 'anoop', canWrite: true });
    expect(f.calls[0]!.url).toBe('https://api.zotero.org/keys/current');
    const headers = new Headers(f.calls[0]!.init!.headers);
    expect(headers.get('zotero-api-key')).toBe('ZKEY');
    expect(headers.get('zotero-api-version')).toBe('3');
  });

  it('keyInfo falls back to /keys/<key> when /keys/current is 404', async () => {
    const f = mockFetch((url) => (url.endsWith('/keys/current') ? { status: 404 } : { body: { ...keyBody, access: {} } }));
    const info = await client(f.fn).keyInfo();
    expect(f.calls[1]!.url).toBe('https://api.zotero.org/keys/ZKEY');
    expect(info.canWrite).toBe(false);
  });

  it('searchItems queries top-level items with quick-search params', async () => {
    const f = mockFetch(() => ({ body: [zItem({ title: 'A' })] }));
    const items = await client(f.fn).searchItems('12345', 'attention', { limit: 20 });
    expect(items).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe('/users/12345/items/top');
    expect(u.searchParams.get('q')).toBe('attention');
    expect(u.searchParams.get('qmode')).toBe('titleCreatorYear');
    expect(u.searchParams.get('limit')).toBe('20');
    expect(u.searchParams.get('sort')).toBe('dateModified');
  });

  it('findByDoi only accepts an exact normalized DOI match', async () => {
    const f = mockFetch(() => ({ body: [zItem({ DOI: '10.1/OTHER' }), zItem({ DOI: 'https://doi.org/10.1/X' })] }));
    const hit = await client(f.fn).findByDoi('12345', '10.1/x');
    expect(hit?.data.DOI).toBe('https://doi.org/10.1/X');
    const miss = await client(f.fn).findByDoi('12345', '10.9/none');
    expect(miss).toBeNull();
  });

  it('createItem POSTs a one-element array with a write token and parses the new key', async () => {
    const f = mockFetch(() => ({ body: { successful: { '0': { key: 'NEWKEY12' } }, failed: {} } }));
    const res = await client(f.fn).createItem('12345', paperToZoteroItem(paper(), 'COLL1'));
    expect(res.key).toBe('NEWKEY12');
    const call = f.calls[0]!;
    expect(call.init!.method).toBe('POST');
    const headers = new Headers(call.init!.headers);
    expect(headers.get('zotero-write-token')).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(call.init!.body)) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it('createItem surfaces per-item failures as ApiError', async () => {
    const f = mockFetch(() => ({ body: { successful: {}, failed: { '0': { code: 400, message: 'invalid field' } } } }));
    await expect(client(f.fn).createItem('12345', paperToZoteroItem(paper(), ''))).rejects.toThrow('invalid field');
  });

  it('retries after a 429 with Retry-After and then succeeds', async () => {
    let first = true;
    const f = mockFetch(() => {
      if (first) {
        first = false;
        return { status: 429, headers: { 'retry-after': '0' } };
      }
      return { body: [] };
    });
    const items = await client(f.fn).searchItems('12345', 'x');
    expect(items).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it('maps 403 to an ApiError with a settings hint', async () => {
    const f = mockFetch(() => ({ status: 403 }));
    const err = await client(f.fn).keyInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).provider).toBe('zotero');
    expect(describeError(err)).toBe('Zotero rejected the API key — check it in Settings');
  });

  it('classifies 503 as rate limiting', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, maxRateLimitRetries: 0 });
    const f = mockFetch(() => ({ status: 503 }));
    const c = new ZoteroClient({ queue: q, fetchFn: f.fn, getApiKey: () => 'ZKEY' });
    await expect(c.searchItems('12345', 'x')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('collections paginates past a full page', async () => {
    const page = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `C${offset + i}`, data: { name: `Coll ${offset + i}`, parentCollection: false as const } }));
    const f = mockFetch((url) => {
      const start = Number(new URL(url).searchParams.get('start'));
      return { body: start === 0 ? page(100, 0) : page(50, 100) };
    });
    const all = await client(f.fn).collections('12345');
    expect(all).toHaveLength(150);
    expect(new URL(f.calls[1]!.url).searchParams.get('start')).toBe('100');
    expect(all[149]).toEqual({ key: 'C149', name: 'Coll 149', parentCollection: false });
  });
});

describe('ZoteroConnectorClient', () => {
  it('POSTs a translator-style item into the running app', async () => {
    const f = mockFetch(() => ({ status: 201, body: {} }));
    const c = new ZoteroConnectorClient({ queue: queue(), fetchFn: f.fn });
    await c.saveItem(paperToConnectorItem(paper()), 'https://doi.org/10.1/x');
    const call = f.calls[0]!;
    expect(call.url).toBe('/zotero-local/connector/saveItems');
    expect(call.init!.method).toBe('POST');
    const headers = new Headers(call.init!.headers);
    expect(headers.get('x-zotero-connector-api-version')).toBe('3');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(call.init!.body)) as { sessionID: string; uri: string; items: Record<string, unknown>[] };
    expect(body.sessionID).toMatch(/^[0-9a-f]{32}$/);
    expect(body.uri).toBe('https://doi.org/10.1/x');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.creators).toEqual([
      { creatorType: 'author', lastName: 'Ashish Vaswani', fieldMode: 1 },
      { creatorType: 'author', lastName: 'Noam Shazeer', fieldMode: 1 },
    ]);
    expect(body.items[0]!.collections).toBeUndefined();
    expect(body.items[0]!.attachments).toEqual([]);
  });

  it('surfaces failures as ApiError', async () => {
    const f = mockFetch(() => ({ status: 500 }));
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, maxRetries: 0, maxRateLimitRetries: 0 });
    const c = new ZoteroConnectorClient({ queue: q, fetchFn: f.fn });
    await expect(c.saveItem(paperToConnectorItem(paper()), 'https://x')).rejects.toBeInstanceOf(ApiError);
  });

  it('downloads and uploads the PDF as a child attachment', async () => {
    const f = mockFetch((url) => {
      if (url.endsWith('/connector/saveItems')) return { status: 201, body: {} };
      if (url.startsWith('https://arxiv.org/pdf/')) return { status: 200, body: 'pdf-bytes' };
      if (url.includes('/connector/saveAttachment')) return { status: 201, body: {} };
      return { status: 404 };
    });
    const c = new ZoteroConnectorClient({ queue: queue(), fetchFn: f.fn });
    const res = await c.saveItem(paperToConnectorItem(paper()), 'https://doi.org/10.1/x', 'https://arxiv.org/pdf/1706.03762');
    expect(res.pdfAttached).toBe(true);
    const saveBody = JSON.parse(String(f.calls[0]!.init!.body)) as { sessionID: string; items: { id: string }[] };
    const upload = f.calls[2]!;
    expect(upload.url).toBe(`/zotero-local/connector/saveAttachment?sessionID=${saveBody.sessionID}`);
    const headers = new Headers(upload.init!.headers);
    expect(headers.get('content-type')).toBe('application/pdf');
    const meta = JSON.parse(headers.get('x-metadata')!) as Record<string, string>;
    expect(meta.parentItemID).toBe(saveBody.items[0]!.id);
    expect(meta.title).toBe('Full Text PDF');
    expect(upload.init!.body).toBeInstanceOf(Blob);
  });

  it('still reports success when the PDF download fails', async () => {
    const f = mockFetch((url) => {
      if (url.endsWith('/connector/saveItems')) return { status: 201, body: {} };
      return { status: 404 };
    });
    const c = new ZoteroConnectorClient({ queue: queue(), fetchFn: f.fn });
    const res = await c.saveItem(paperToConnectorItem(paper()), 'https://x', 'https://blocked.example/paper.pdf');
    expect(res.pdfAttached).toBe(false);
    expect(f.calls.some((call) => call.url.includes('saveAttachment'))).toBe(false);
  });
});

describe('pdfCandidateUrl', () => {
  it('prefers the canonical arXiv PDF over provider OA links (which can be misattributed), else null', () => {
    // e.g. S2's openAccessPdf for ResNet points at an unrelated repository document.
    expect(pdfCandidateUrl(paper({ openAccessPdf: { url: 'https://repo.example/wrong.pdf' } }))).toBe('https://arxiv.org/pdf/1706.03762');
    expect(pdfCandidateUrl(paper({ externalIds: { DOI: '10.1/x' }, openAccessPdf: { url: 'https://oa/x.pdf' } }))).toBe('https://oa/x.pdf');
    expect(pdfCandidateUrl(paper({ externalIds: { DOI: '10.1/x' } }))).toBeNull();
  });
});

describe('makeWriteToken', () => {
  it('returns unique 32-char hex tokens', () => {
    const a = makeWriteToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(makeWriteToken()).not.toBe(a);
  });
});

describe('lookupFromZoteroItem', () => {
  it('prefers the DOI field', () => {
    expect(lookupFromZoteroItem(zItem({ DOI: '10.18653/v1/N19-1423', url: 'https://arxiv.org/abs/1810.04805' }))).toBe('DOI:10.18653/v1/N19-1423');
  });
  it('reads a preprint archiveID', () => {
    expect(lookupFromZoteroItem(zItem({ itemType: 'preprint', archiveID: 'arXiv:2101.00001' }))).toBe('ARXIV:2101.00001');
  });
  it('reads arXiv and DOI lines from Extra', () => {
    expect(lookupFromZoteroItem(zItem({ extra: 'Publisher: x\narXiv: 1706.03762' }))).toBe('ARXIV:1706.03762');
    expect(lookupFromZoteroItem(zItem({ extra: 'DOI: 10.1234/xyz' }))).toBe('DOI:10.1234/xyz');
  });
  it('falls back to the URL', () => {
    expect(lookupFromZoteroItem(zItem({ url: 'https://doi.org/10.1234/xyz' }))).toBe('DOI:10.1234/xyz');
  });
  it('returns null when nothing identifies the item', () => {
    expect(lookupFromZoteroItem(zItem({ title: 'Some Book', url: 'https://example.com/book' }))).toBeNull();
  });
});

function paper(over: Partial<Paper> = {}): Paper {
  return {
    paperId: 'doi:10.1/x',
    sources: { s2: 'abc' },
    title: 'Attention Is All You Need',
    year: 2017,
    authors: [{ authorId: '1', name: 'Ashish Vaswani' }, { authorId: null, name: 'Noam Shazeer' }],
    venue: 'NeurIPS',
    journal: { name: 'NeurIPS', volume: '30', pages: '5998-6008' },
    citationCount: 1,
    referenceCount: 0,
    influentialCitationCount: null,
    externalIds: { DOI: '10.1/x', ArXiv: '1706.03762' },
    isOpenAccess: false,
    openAccessPdf: null,
    publicationTypes: ['Conference'],
    publicationDate: '2017-06-12',
    abstract: 'The dominant…',
    detailLevel: 'full',
    fetchedAt: 0,
    ...over,
  };
}

describe('paperToZoteroItem', () => {
  it('maps a conference paper with the arXiv id on an Extra line', () => {
    const item = paperToZoteroItem(paper(), 'COLL1');
    expect(item.itemType).toBe('conferencePaper');
    expect(item.proceedingsTitle).toBe('NeurIPS');
    expect(item.pages).toBe('5998-6008');
    expect(item.extra).toBe('arXiv:1706.03762');
    expect(item.DOI).toBe('10.1/x');
    expect(item.date).toBe('2017-06-12');
    expect(item.collections).toEqual(['COLL1']);
    expect(item.creators).toEqual([
      { creatorType: 'author', name: 'Ashish Vaswani' },
      { creatorType: 'author', name: 'Noam Shazeer' },
    ]);
  });
  it('maps a journal article with volume and pages', () => {
    const item = paperToZoteroItem(paper({ publicationTypes: ['JournalArticle'], externalIds: { DOI: '10.1/x' } }), '');
    expect(item.itemType).toBe('journalArticle');
    expect(item.publicationTitle).toBe('NeurIPS');
    expect(item.volume).toBe('30');
    expect(item.extra).toBe('');
    expect(item.collections).toEqual([]);
  });
  it('maps an arXiv-only paper to a preprint', () => {
    const item = paperToZoteroItem(paper({ venue: '', journal: null, externalIds: { ArXiv: '1706.03762' }, publicationTypes: [] }), '');
    expect(item.itemType).toBe('preprint');
    expect(item.repository).toBe('arXiv');
    expect(item.archiveID).toBe('arXiv:1706.03762');
    expect(item.url).toBe('https://arxiv.org/abs/1706.03762');
  });
  it('omits the abstract only when the paper has none', () => {
    expect(paperToZoteroItem(paper({ abstract: null }), '').abstractNote).toBe('');
    expect(paperToZoteroItem(paper(), '').abstractNote).toBe('The dominant…');
  });
});
