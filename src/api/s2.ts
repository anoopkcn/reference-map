import { S2_API, type DetailLevel, type ListKind, type Lookup, type Paper, type PaperId } from '../types';
import { AbortedError, NetworkError, NotFoundError, RateLimitedError, S2Error } from './errors';
import { DETAIL_FIELDS_PARAM, LIST_FIELDS_PARAM, S2_LIMITS } from './fields';
import { normalizePaper, type S2PaperRaw } from './normalize';
import type { EnqueueOptions, RequestQueue } from './queue';

export interface S2ClientOptions {
  queue: RequestQueue;
  getApiKey?: () => string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

export interface ListResult {
  /** Ids in S2 order, excluding unresolved entries (paperId null). */
  ids: PaperId[];
  papers: Paper[];
  /** Whether more entries exist beyond what was fetched. */
  hasMore: boolean;
}

export interface SearchResult {
  papers: Paper[];
  total: number;
}

export const PRIORITY = { seed: 3, detail: 2, list: 1, search: 2, batch: 3 } as const;

/** Typed, queued client for the Semantic Scholar Graph API. */
export class S2Client {
  private queue: RequestQueue;
  private getApiKey: () => string;
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private now: () => number;

  constructor(opts: S2ClientOptions) {
    this.queue = opts.queue;
    this.getApiKey = opts.getApiKey ?? (() => '');
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = opts.baseUrl ?? S2_API;
    this.now = opts.now ?? (() => Date.now());
  }

  /** GET /paper/{lookup}. Throws NotFoundError for unknown ids. */
  async getPaper(lookup: Lookup, level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<Paper> {
    const fields = level === 'full' ? DETAIL_FIELDS_PARAM : LIST_FIELDS_PARAM;
    const raw = await this.request<S2PaperRaw>(
      `paper:${level}:${lookup.toLowerCase()}`,
      `/paper/${encodeURIComponent(lookup)}?fields=${fields}`,
      undefined,
      { priority: PRIORITY.detail, ...options },
    );
    const p = normalizePaper(raw, level, this.now());
    if (!p) throw new NotFoundError();
    return p;
  }

  /** GET /paper/{id}/references|citations. */
  async getList(id: PaperId, kind: ListKind, limit: number, options: EnqueueOptions = {}): Promise<ListResult> {
    const lim = Math.max(1, Math.min(S2_LIMITS.list, Math.floor(limit)));
    const path = kind === 'refs' ? 'references' : 'citations';
    const field = kind === 'refs' ? 'citedPaper' : 'citingPaper';
    const raw = await this.request<{ next?: number; data?: Record<string, S2PaperRaw | null>[] }>(
      `${kind}:${id}:${lim}`,
      `/paper/${encodeURIComponent(id)}/${path}?limit=${lim}&fields=${LIST_FIELDS_PARAM}`,
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
    return { ids, papers, hasMore: raw.next !== undefined && raw.next !== null };
  }

  /** POST /paper/batch — up to 500 lookups; result aligned with input (null for misses). */
  async getBatch(lookups: readonly Lookup[], level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<(Paper | null)[]> {
    if (lookups.length === 0) return [];
    if (lookups.length > S2_LIMITS.batch) {
      const out: (Paper | null)[] = [];
      for (let i = 0; i < lookups.length; i += S2_LIMITS.batch) {
        out.push(...(await this.getBatch(lookups.slice(i, i + S2_LIMITS.batch), level, options)));
      }
      return out;
    }
    const fields = level === 'full' ? DETAIL_FIELDS_PARAM : LIST_FIELDS_PARAM;
    const key = `batch:${level}:${lookups.map((l) => l.toLowerCase()).join('|')}`;
    const raw = await this.request<(S2PaperRaw | null)[]>(
      key,
      `/paper/batch?fields=${fields}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: lookups }) },
      { priority: PRIORITY.batch, ...options },
    );
    const now = this.now();
    return lookups.map((_, i) => normalizePaper(raw[i], level, now));
  }

  /** GET /paper/search. */
  async search(query: string, limit = 10, options: EnqueueOptions = {}): Promise<SearchResult> {
    const q = query.trim();
    const lim = Math.max(1, Math.min(S2_LIMITS.search, limit));
    const raw = await this.request<{ total?: number; data?: S2PaperRaw[] }>(
      `search:${lim}:${q.toLowerCase()}`,
      `/paper/search?query=${encodeURIComponent(q)}&limit=${lim}&fields=${LIST_FIELDS_PARAM}`,
      undefined,
      { priority: PRIORITY.search, ...options },
    );
    const now = this.now();
    const papers = (raw.data ?? []).map((r) => normalizePaper(r, 'list', now)).filter((p): p is Paper => !!p);
    return { papers, total: raw.total ?? papers.length };
  }

  private request<T>(key: string, path: string, init: RequestInit | undefined, options: EnqueueOptions): Promise<T> {
    return this.queue.enqueue<T>(
      key,
      async (signal) => {
        const headers = new Headers(init?.headers);
        headers.set('Accept', 'application/json');
        const apiKey = this.getApiKey();
        if (apiKey) headers.set('x-api-key', apiKey);
        let res: Response;
        try {
          res = await this.fetchFn(this.baseUrl + path, { ...init, headers, signal });
        } catch (e) {
          if (signal.aborted) throw new AbortedError();
          throw new NetworkError(e instanceof Error ? e.message : 'Network error');
        }
        if (res.status === 429) throw new RateLimitedError(parseRetryAfter(res.headers.get('retry-after')), 'Rate limited', await safeBody(res));
        if (res.status === 404) throw new NotFoundError('Not found', await safeBody(res));
        if (!res.ok) throw new S2Error(res.status, `HTTP ${res.status}`, await safeBody(res));
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
