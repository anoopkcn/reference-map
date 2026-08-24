import { S2_API, type DetailLevel, type ListKind, type Lookup, type Paper, type PaperId } from '../types';
import { AbortedError, ApiError, NetworkError, NotFoundError, RateLimitedError, UnsupportedLookupError } from './errors';
import { DETAIL_FIELDS_PARAM, LIST_FIELDS_PARAM, S2_LIMITS } from './fields';
import { normalizePaper, type S2PaperRaw } from './normalize';
import { PRIORITY, ProviderStats, type ListResult, type OpKind, type Provider, type SearchResult } from './provider';
import type { EnqueueOptions, RequestQueue } from './queue';

export { PRIORITY } from './provider';
export type { ListResult, SearchResult } from './provider';

export interface S2ClientOptions {
  queue: RequestQueue;
  getApiKey?: () => string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  /** Whether the machine believes it is online (default: navigator.onLine, true when unknown). */
  onLine?: () => boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
/** lookup kind (lower-case) → S2 prefix */
const S2_PREFIX: Record<string, string> = { doi: 'DOI', arxiv: 'ARXIV', pmid: 'PMID', pmcid: 'PMCID', mag: 'MAG', acl: 'ACL', corpusid: 'CorpusId', url: 'URL' };

/** Typed, queued client for the Semantic Scholar Graph API. */
export class S2Client implements Provider {
  readonly id = 's2' as const;
  readonly queue: RequestQueue;
  readonly stats: ProviderStats;
  private getApiKey: () => string;
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private now: () => number;
  private onLine: () => boolean;

  constructor(opts: S2ClientOptions) {
    this.queue = opts.queue;
    this.getApiKey = opts.getApiKey ?? (() => '');
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = opts.baseUrl ?? S2_API;
    this.now = opts.now ?? (() => Date.now());
    this.onLine = opts.onLine ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    this.stats = new ProviderStats(this.now);
  }

  toNative(lookup: Lookup): string | null {
    const t = lookup.trim();
    if (SHA_RE.test(t)) return t.toLowerCase();
    const m = /^([a-z0-9]+)\s*:\s*(\S.*)$/i.exec(t);
    if (!m) return null;
    const kind = m[1]!.toLowerCase();
    const v = m[2]!.trim();
    if (kind === 's2') return SHA_RE.test(v) ? v.toLowerCase() : null;
    const pre = S2_PREFIX[kind];
    if (!pre) return null;
    if (kind === 'pmcid') return `PMCID:${v.replace(/^PMC/i, '')}`;
    return `${pre}:${v}`;
  }

  lookupFor(p: Pick<Paper, 'sources' | 'externalIds'>): string | null {
    if (p.sources.s2) return p.sources.s2;
    const x = p.externalIds;
    if (x.DOI) return `DOI:${x.DOI}`;
    if (x.ArXiv) return `ARXIV:${x.ArXiv}`;
    if (x.PubMed) return `PMID:${x.PubMed}`;
    if (x.MAG) return `MAG:${x.MAG}`;
    if (x.ACL) return `ACL:${x.ACL}`;
    if (x.CorpusId) return `CorpusId:${x.CorpusId}`;
    return null;
  }

  supportsList(kind: ListKind): boolean {
    return kind !== 'related';
  }

  resolve(lookup: Lookup, level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<Paper> {
    const native = this.toNative(lookup);
    if (!native) return Promise.reject(new UnsupportedLookupError(lookup, 's2'));
    return this.getPaper(native, level, options, 'resolve');
  }

  /** GET /paper/{id}. Throws NotFoundError for unknown ids. */
  async getPaper(native: string, level: DetailLevel = 'list', options: EnqueueOptions = {}, op: OpKind = 'detail'): Promise<Paper> {
    const fields = level === 'full' ? DETAIL_FIELDS_PARAM : LIST_FIELDS_PARAM;
    const raw = await this.request<S2PaperRaw>(
      op,
      `paper:${level}:${native.toLowerCase()}`,
      `/paper/${encodeURIComponent(native)}?fields=${fields}`,
      undefined,
      { priority: PRIORITY.detail, ...options },
    );
    const p = normalizePaper(raw, level, this.now());
    if (!p) throw new NotFoundError('Not found', undefined, 's2');
    return p;
  }

  /** GET /paper/{id}/references|citations. */
  async getList(native: string, kind: ListKind, limit: number, options: EnqueueOptions = {}): Promise<ListResult> {
    if (!this.supportsList(kind)) throw new UnsupportedLookupError(`${kind}:${native}`, 's2');
    const lim = Math.max(1, Math.min(S2_LIMITS.list, Math.floor(limit)));
    const path = kind === 'refs' ? 'references' : 'citations';
    const field = kind === 'refs' ? 'citedPaper' : 'citingPaper';
    const raw = await this.request<{ next?: number; data?: Record<string, S2PaperRaw | null>[] }>(
      kind,
      `${kind}:${native}:${lim}`,
      `/paper/${encodeURIComponent(native)}/${path}?limit=${lim}&fields=${LIST_FIELDS_PARAM}`,
      undefined,
      { priority: PRIORITY.list, ...options },
    );
    const now = this.now();
    const ids: PaperId[] = [];
    const papers: Paper[] = [];
    const seen = new Set<PaperId>();
    for (const row of raw.data ?? []) {
      const p = normalizePaper(row?.[field], 'list', now);
      if (!p || seen.has(p.paperId)) continue;
      seen.add(p.paperId);
      ids.push(p.paperId);
      papers.push(p);
    }
    return { ids, papers, hasMore: raw.next !== undefined && raw.next !== null, total: null };
  }

  /** POST /paper/batch — up to 500 lookups; result aligned with input (null for misses / unsupported). */
  async getBatch(lookups: readonly Lookup[], level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<(Paper | null)[]> {
    if (lookups.length === 0) return [];
    if (lookups.length > S2_LIMITS.batch) {
      const out: (Paper | null)[] = [];
      for (let i = 0; i < lookups.length; i += S2_LIMITS.batch) {
        out.push(...(await this.getBatch(lookups.slice(i, i + S2_LIMITS.batch), level, options)));
      }
      return out;
    }
    const natives = lookups.map((l) => this.toNative(l));
    const supported = natives.filter((n): n is string => n !== null);
    const results: (Paper | null)[] = new Array(lookups.length).fill(null);
    if (supported.length === 0) return results;
    const fields = level === 'full' ? DETAIL_FIELDS_PARAM : LIST_FIELDS_PARAM;
    const key = `batch:${level}:${supported.map((l) => l.toLowerCase()).join('|')}`;
    const raw = await this.request<(S2PaperRaw | null)[]>(
      'batch',
      key,
      `/paper/batch?fields=${fields}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: supported }) },
      { priority: PRIORITY.batch, ...options },
    );
    const now = this.now();
    let j = 0;
    natives.forEach((n, i) => {
      if (n === null) return;
      results[i] = normalizePaper(raw[j++], level, now);
    });
    return results;
  }

  /** GET /paper/search. */
  async search(query: string, limit = 10, options: EnqueueOptions = {}): Promise<SearchResult> {
    const q = query.trim();
    const lim = Math.max(1, Math.min(S2_LIMITS.search, limit));
    const raw = await this.request<{ total?: number; data?: S2PaperRaw[] }>(
      'search',
      `search:${lim}:${q.toLowerCase()}`,
      `/paper/search?query=${encodeURIComponent(q)}&limit=${lim}&fields=${LIST_FIELDS_PARAM}`,
      undefined,
      { priority: PRIORITY.search, ...options },
    );
    const now = this.now();
    const papers = (raw.data ?? []).map((r) => normalizePaper(r, 'list', now)).filter((p): p is Paper => !!p);
    return { papers, total: raw.total ?? papers.length };
  }

  private request<T>(op: OpKind, key: string, path: string, init: RequestInit | undefined, options: EnqueueOptions): Promise<T> {
    return this.queue.enqueue<T>(
      key,
      async (signal) => {
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'application/json');
        const apiKey = this.getApiKey();
        if (apiKey) headers.set('x-api-key', apiKey);
        const t0 = this.now();
        let res: Response;
        try {
          res = await this.fetchFn(this.baseUrl + path, { ...init, headers, signal });
        } catch (e) {
          if (signal.aborted) throw new AbortedError();
          // The public S2 pool omits CORS headers on 429/5xx responses, so the browser reports
          // them as opaque network failures. While online, treat one as a rate limit — pausing
          // the queue instead of hammering a closed door — and let the Router fail over.
          const err = this.onLine()
            ? new RateLimitedError(null, 'Rate limited', undefined, 's2')
            : new NetworkError(e instanceof Error ? e.message : 'Network error', 's2');
          this.stats.record(op, false, this.now() - t0, err);
          throw err;
        }
        const ms = this.now() - t0;
        if (res.status === 429) {
          const err = new RateLimitedError(parseRetryAfter(res.headers.get('retry-after')), 'Rate limited', await safeBody(res), 's2');
          this.stats.record(op, false, ms, err);
          throw err;
        }
        if (res.status === 404) throw new NotFoundError('Not found', await safeBody(res), 's2'); // not a health problem
        if (!res.ok) {
          const err = new ApiError(res.status, `HTTP ${res.status}`, await safeBody(res), 's2');
          this.stats.record(op, false, ms, err);
          throw err;
        }
        this.stats.record(op, true, ms);
        return (await res.json()) as T;
      },
      options,
    );
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Retry-After: seconds or HTTP-date → ms from now; null when absent/unparseable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - now);
}
