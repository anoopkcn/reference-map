import { arxivFromDoi, normArxiv, normDoi } from '../lib/identity';
import { OPENALEX_API, type Author, type DetailLevel, type ExternalIds, type Journal, type ListKind, type Lookup, type Paper, type PaperId } from '../types';
import { AbortedError, ApiError, NetworkError, NotFoundError, RateLimitedError, UnsupportedLookupError } from './errors';
import { PRIORITY, ProviderStats, type ListResult, type OpKind, type Provider, type SearchResult } from './provider';
import type { EnqueueOptions, RequestQueue } from './queue';
import { parseRetryAfter } from './s2';

export interface OpenAlexClientOptions {
  queue: RequestQueue;
  /** Contact e-mail for the polite pool (optional). */
  getMailto?: () => string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

/** ≈4.5 req/s, comfortably under OpenAlex's 10 req/s ceiling. */
export const OA_QUEUE = { concurrency: 3, minIntervalMs: 220 } as const;
export const OA_LIMITS = { perPage: 200, filterIds: 50, search: 100 } as const;

export const OA_LIST_SELECT =
  'id,doi,ids,title,display_name,publication_year,publication_date,cited_by_count,referenced_works_count,type,type_crossref,biblio,primary_location,best_oa_location,open_access,authorships';
export const OA_FULL_SELECT = `${OA_LIST_SELECT},abstract_inverted_index`;

export interface OAWorkRaw {
  id?: string | null;
  doi?: string | null;
  ids?: { openalex?: string | null; doi?: string | null; mag?: string | number | null; pmid?: string | null; pmcid?: string | null } | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  cited_by_count?: number | null;
  referenced_works_count?: number | null;
  referenced_works?: string[] | null;
  type?: string | null;
  type_crossref?: string | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null } | null;
  primary_location?: OALocation | null;
  best_oa_location?: OALocation | null;
  open_access?: { is_oa?: boolean | null; oa_status?: string | null; oa_url?: string | null } | null;
  authorships?: { author?: { id?: string | null; display_name?: string | null } | null }[] | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}
interface OALocation {
  source?: { id?: string | null; display_name?: string | null } | null;
  landing_page_url?: string | null;
  pdf_url?: string | null;
}
interface OAListResponse {
  meta?: { count?: number; next_cursor?: string | null; per_page?: number };
  results?: OAWorkRaw[];
}

const W_RE = /^W\d+$/i;

function tail(url: string | null | undefined): string {
  if (!url) return '';
  const m = /\/([^/?#]+)(?:[?#].*)?$/.exec(url.trim());
  return m ? m[1]! : url.trim();
}

function digits(s: string | null | undefined): string | null {
  const m = /(\d+)/.exec(s ?? '');
  return m ? m[1]! : null;
}

/** Rebuild abstract text from OpenAlex's inverted index. */
export function abstractFromInvertedIndex(idx: Record<string, number[]> | null | undefined): string | null {
  if (!idx) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(idx)) for (const pos of positions) words[pos] = word;
  const text = words.filter((w) => w !== undefined).join(' ').trim();
  return text || null;
}

/** OpenAlex work type → our publication-type tokens (labelled via pubTypeLabel). */
export function oaTypeToS2(type: string | null | undefined, crossref?: string | null): string[] {
  const out: string[] = [];
  switch (type) {
    case 'article':
      out.push('JournalArticle');
      break;
    case 'preprint':
      out.push('Preprint');
      break;
    case 'book':
      out.push('Book');
      break;
    case 'book-chapter':
      out.push('BookSection');
      break;
    case 'dissertation':
      out.push('Dissertation');
      break;
    case 'review':
      out.push('Review');
      break;
    case 'editorial':
      out.push('Editorial');
      break;
    case 'letter':
      out.push('LettersAndComments');
      break;
    case 'dataset':
      out.push('Dataset');
      break;
    default:
      break;
  }
  if (crossref === 'proceedings-article') out.push('Conference');
  return out;
}

/** Convert a raw OpenAlex work to our Paper (provisional id `oa:W…`). */
export function normalizeOpenAlex(raw: OAWorkRaw | null | undefined, level: DetailLevel, now = Date.now()): Paper | null {
  const wid = raw ? tail(raw.id ?? raw.ids?.openalex) : '';
  if (!raw || !W_RE.test(wid)) return null;
  const W = wid.toUpperCase();
  const externalIds: ExternalIds = {};
  const doiRaw = raw.doi ?? raw.ids?.doi ?? null;
  if (doiRaw) externalIds.DOI = normDoi(doiRaw);
  const ax = (doiRaw && arxivFromDoi(doiRaw)) || arxivFromLanding(raw.primary_location?.landing_page_url) || arxivFromLanding(raw.best_oa_location?.landing_page_url);
  if (ax) externalIds.ArXiv = ax;
  if (raw.ids?.mag) externalIds.MAG = String(raw.ids.mag);
  const pmid = digits(raw.ids?.pmid);
  if (pmid) externalIds.PubMed = pmid;
  const pmc = digits(raw.ids?.pmcid);
  if (pmc) externalIds.PubMedCentral = pmc;

  const authors: Author[] = (raw.authorships ?? [])
    .map((a) => a?.author)
    .filter((a): a is { id?: string | null; display_name?: string | null } => !!a && !!a.display_name)
    .map((a) => ({ authorId: a.id ? tail(a.id) : null, name: a.display_name!.trim(), provider: 'openalex' }));

  const venue = (raw.primary_location?.source?.display_name ?? raw.best_oa_location?.source?.display_name ?? '').trim();
  const b = raw.biblio;
  let journal: Journal | null = null;
  const pages = b?.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}-${b.last_page}` : b.first_page) : undefined;
  if (venue || b?.volume || pages) {
    journal = {};
    if (venue) journal.name = venue;
    if (b?.volume) journal.volume = b.volume;
    if (pages) journal.pages = pages;
  }
  const pdf = raw.best_oa_location?.pdf_url ?? raw.open_access?.oa_url ?? null;
  const p: Paper = {
    paperId: `oa:${W}`,
    sources: { openalex: W },
    title: (raw.title ?? raw.display_name ?? '').trim() || 'Untitled',
    year: typeof raw.publication_year === 'number' ? raw.publication_year : null,
    authors,
    venue,
    journal,
    citationCount: raw.cited_by_count ?? 0,
    referenceCount: raw.referenced_works_count ?? raw.referenced_works?.length ?? 0,
    influentialCitationCount: null,
    externalIds,
    isOpenAccess: !!raw.open_access?.is_oa,
    openAccessPdf: pdf ? { url: pdf, ...(raw.open_access?.oa_status ? { status: raw.open_access.oa_status } : {}) } : null,
    publicationTypes: oaTypeToS2(raw.type, raw.type_crossref),
    publicationDate: raw.publication_date ?? null,
    detailLevel: level,
    fetchedAt: now,
  };
  if (level === 'full') {
    p.abstract = abstractFromInvertedIndex(raw.abstract_inverted_index);
    p.bibtex = null;
  }
  return p;
}

function arxivFromLanding(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/i.exec(url);
  return m ? normArxiv(m[1]!) : null;
}

type NativeKind = 'openalex' | 'doi' | 'pmid' | 'mag' | 'pmcid';
function splitNative(native: string): { kind: NativeKind; value: string } | null {
  if (W_RE.test(native)) return { kind: 'openalex', value: native.toUpperCase() };
  const m = /^(doi|pmid|mag|pmcid):(.+)$/.exec(native);
  return m ? { kind: m[1] as NativeKind, value: m[2]! } : null;
}

/** Typed, queued client for the OpenAlex API. */
export class OpenAlexClient implements Provider {
  readonly id = 'openalex' as const;
  readonly queue: RequestQueue;
  readonly stats: ProviderStats;
  private getMailto: () => string;
  private fetchFn: typeof fetch;
  private baseUrl: string;
  private now: () => number;

  constructor(opts: OpenAlexClientOptions) {
    this.queue = opts.queue;
    this.getMailto = opts.getMailto ?? (() => '');
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.baseUrl = opts.baseUrl ?? OPENALEX_API;
    this.now = opts.now ?? (() => Date.now());
    this.stats = new ProviderStats(this.now);
  }

  /** Native forms: `W123` | `doi:<lower>` | `pmid:<n>` | `mag:<n>` | `pmcid:PMC<n>`. */
  toNative(lookup: Lookup): string | null {
    const t = lookup.trim();
    if (W_RE.test(t)) return t.toUpperCase();
    const m = /^([a-z0-9]+)\s*:\s*(\S.*)$/i.exec(t);
    if (!m) return null;
    const kind = m[1]!.toLowerCase();
    const v = m[2]!.trim();
    switch (kind) {
      case 'oa':
      case 'openalex':
        return W_RE.test(v) ? v.toUpperCase() : null;
      case 'doi': {
        if (arxivFromDoi(v)) return null; // DataCite arXiv DOIs are not reliably resolvable here
        const d = normDoi(v);
        return d ? `doi:${d}` : null;
      }
      case 'pmid':
        return /^\d+$/.test(v) ? `pmid:${v}` : null;
      case 'mag':
        return /^\d+$/.test(v) ? `mag:${v}` : null;
      case 'pmcid':
        return `pmcid:PMC${v.replace(/^PMC/i, '')}`;
      default:
        return null; // arxiv, acl, corpusid, url, s2 sha
    }
  }

  lookupFor(p: Pick<Paper, 'sources' | 'externalIds'>): string | null {
    if (p.sources.openalex) return p.sources.openalex;
    const x = p.externalIds;
    if (x.DOI && !arxivFromDoi(x.DOI)) return `doi:${normDoi(x.DOI)}`;
    if (x.PubMed) return `pmid:${x.PubMed}`;
    if (x.MAG) return `mag:${x.MAG}`;
    return null;
  }

  resolve(lookup: Lookup, level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<Paper> {
    const native = this.toNative(lookup);
    if (!native) return Promise.reject(new UnsupportedLookupError(lookup, 'openalex'));
    return this.getPaper(native, level, options, 'resolve');
  }

  async getPaper(native: string, level: DetailLevel = 'list', options: EnqueueOptions = {}, op: OpKind = 'detail'): Promise<Paper> {
    const select = level === 'full' ? OA_FULL_SELECT : OA_LIST_SELECT;
    const raw = await this.request<OAWorkRaw>(op, `oa:paper:${level}:${native}`, `/works/${encodeNative(native)}`, { select }, { priority: PRIORITY.detail, ...options });
    const p = normalizeOpenAlex(raw, level, this.now());
    if (!p) throw new NotFoundError('Not found', undefined, 'openalex');
    return p;
  }

  async getList(native: string, kind: ListKind, limit: number, options: EnqueueOptions = {}): Promise<ListResult> {
    const W = native.toUpperCase();
    if (!W_RE.test(W)) {
      // lists need the OpenAlex id: resolve it first
      const p = await this.getPaper(native, 'list', options, kind);
      return this.getList(p.sources.openalex!, kind, limit, options);
    }
    const lim = Math.max(1, Math.floor(limit));
    const now = this.now();
    if (kind === 'refs') {
      const work = await this.request<OAWorkRaw>(kind, `oa:refids:${W}`, `/works/${W}`, { select: 'id,referenced_works' }, { priority: PRIORITY.list, ...options });
      const allIds = (work.referenced_works ?? []).map((u) => tail(u).toUpperCase()).filter((w) => W_RE.test(w));
      const wanted = allIds.slice(0, lim);
      const papers = await this.fetchWorksByIds(wanted, 'refs', options);
      const byId = new Map(papers.map((p) => [p.sources.openalex!, p]));
      const ordered = wanted.map((w) => byId.get(w)).filter((p): p is Paper => !!p);
      return { ids: ordered.map((p) => p.paperId), papers: ordered, hasMore: allIds.length > wanted.length, total: allIds.length };
    }
    const papers: Paper[] = [];
    const seen = new Set<PaperId>();
    let cursor: string | null = '*';
    let total: number | null = null;
    while (cursor && papers.length < lim) {
      const perPage = Math.min(OA_LIMITS.perPage, lim - papers.length);
      const page: OAListResponse = await this.request<OAListResponse>(
        kind,
        `oa:cites:${W}:${perPage}:${cursor}`,
        '/works',
        { filter: `cites:${W}`, sort: 'cited_by_count:desc', 'per-page': String(perPage), cursor, select: OA_LIST_SELECT },
        { priority: PRIORITY.list, ...options },
      );
      total = page.meta?.count ?? total;
      for (const r of page.results ?? []) {
        const p = normalizeOpenAlex(r, 'list', now);
        if (p && !seen.has(p.paperId)) {
          seen.add(p.paperId);
          papers.push(p);
        }
      }
      cursor = page.results?.length ? (page.meta?.next_cursor ?? null) : null;
    }
    return { ids: papers.map((p) => p.paperId), papers, hasMore: total !== null ? total > papers.length : !!cursor, total };
  }

  async getBatch(lookups: readonly Lookup[], level: DetailLevel = 'list', options: EnqueueOptions = {}): Promise<(Paper | null)[]> {
    const results: (Paper | null)[] = new Array(lookups.length).fill(null);
    const groups = new Map<NativeKind, { value: string; index: number }[]>();
    lookups.forEach((l, index) => {
      const native = this.toNative(l);
      const sp = native ? splitNative(native) : null;
      if (!sp) return;
      let g = groups.get(sp.kind);
      if (!g) groups.set(sp.kind, (g = []));
      g.push({ value: sp.value, index });
    });
    const select = level === 'full' ? OA_FULL_SELECT : OA_LIST_SELECT;
    const now = this.now();
    for (const [kind, items] of groups) {
      for (let i = 0; i < items.length; i += OA_LIMITS.filterIds) {
        const chunk = items.slice(i, i + OA_LIMITS.filterIds);
        const filterKey = kind === 'pmcid' ? 'pmcid' : kind;
        try {
          const page = await this.request<OAListResponse>(
            'batch',
            `oa:batch:${kind}:${chunk.map((c) => c.value).join('|')}:${level}`,
            '/works',
            { filter: `${filterKey}:${chunk.map((c) => c.value).join('|')}`, 'per-page': String(chunk.length), select },
            { priority: PRIORITY.batch, ...options },
          );
          const byKey = new Map<string, OAWorkRaw>();
          for (const r of page.results ?? []) {
            const k = keyOfRaw(r, kind);
            if (k) byKey.set(k, r);
          }
          for (const c of chunk) {
            const r = byKey.get(kind === 'doi' ? c.value.toLowerCase() : kind === 'openalex' ? c.value.toUpperCase() : c.value);
            if (r) results[c.index] = normalizeOpenAlex(r, level, now);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
            // malformed filter value (odd DOI) → fall back to individual lookups
            for (const c of chunk) {
              try {
                results[c.index] = await this.getPaper(kind === 'openalex' ? c.value : `${kind}:${c.value}`, level, options, 'batch');
              } catch (e2) {
                if (!(e2 instanceof NotFoundError)) throw e2;
              }
            }
          } else throw e;
        }
      }
    }
    return results;
  }

  async search(query: string, limit = 10, options: EnqueueOptions = {}): Promise<SearchResult> {
    const q = query.trim();
    const lim = Math.max(1, Math.min(OA_LIMITS.search, limit));
    const page = await this.request<OAListResponse>(
      'search',
      `oa:search:${lim}:${q.toLowerCase()}`,
      '/works',
      { search: q, 'per-page': String(lim), select: OA_LIST_SELECT },
      { priority: PRIORITY.search, ...options },
    );
    const now = this.now();
    const papers = (page.results ?? []).map((r) => normalizeOpenAlex(r, 'list', now)).filter((p): p is Paper => !!p);
    return { papers, total: page.meta?.count ?? papers.length };
  }

  private async fetchWorksByIds(ids: readonly string[], op: OpKind, options: EnqueueOptions): Promise<Paper[]> {
    const out: Paper[] = [];
    const now = this.now();
    for (let i = 0; i < ids.length; i += OA_LIMITS.filterIds) {
      const chunk = ids.slice(i, i + OA_LIMITS.filterIds);
      const page = await this.request<OAListResponse>(
        op,
        `oa:works:${chunk.join('|')}`,
        '/works',
        { filter: `openalex:${chunk.join('|')}`, 'per-page': String(chunk.length), select: OA_LIST_SELECT },
        { priority: PRIORITY.list, ...options },
      );
      for (const r of page.results ?? []) {
        const p = normalizeOpenAlex(r, 'list', now);
        if (p) out.push(p);
      }
    }
    return out;
  }

  private request<T>(op: OpKind, key: string, path: string, params: Record<string, string>, options: EnqueueOptions): Promise<T> {
    return this.queue.enqueue<T>(
      key,
      async (signal) => {
        const qs = new URLSearchParams(params);
        const mailto = this.getMailto();
        if (mailto) qs.set('mailto', mailto);
        const url = `${this.baseUrl}${path}?${qs.toString()}`;
        const t0 = this.now();
        let res: Response;
        try {
          res = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal });
        } catch (e) {
          if (signal.aborted) throw new AbortedError();
          const err = new NetworkError(e instanceof Error ? e.message : 'Network error', 'openalex');
          this.stats.record(op, false, this.now() - t0, err);
          throw err;
        }
        const ms = this.now() - t0;
        if (res.status === 429) {
          const err = new RateLimitedError(parseRetryAfter(res.headers.get('retry-after')), 'Rate limited', await safeBody(res), 'openalex');
          this.stats.record(op, false, ms, err);
          throw err;
        }
        if (res.status === 404) throw new NotFoundError('Not found', await safeBody(res), 'openalex');
        if (!res.ok) {
          const err = new ApiError(res.status, `HTTP ${res.status}`, await safeBody(res), 'openalex');
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

function keyOfRaw(r: OAWorkRaw, kind: NativeKind): string | null {
  switch (kind) {
    case 'openalex':
      return tail(r.id ?? r.ids?.openalex).toUpperCase() || null;
    case 'doi': {
      const d = r.doi ?? r.ids?.doi;
      return d ? normDoi(d) : null;
    }
    case 'pmid':
      return digits(r.ids?.pmid);
    case 'mag':
      return r.ids?.mag ? String(r.ids.mag) : null;
    case 'pmcid': {
      const d = digits(r.ids?.pmcid);
      return d ? `PMC${d}` : null;
    }
  }
}

/** `/works/doi:10.1/x` keeps slashes readable but escapes other reserved characters. */
function encodeNative(native: string): string {
  return encodeURIComponent(native).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
