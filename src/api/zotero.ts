import type { Lookup, Paper } from '../types';
import { normalizeLookup } from '../lib/ids';
import { normArxiv, normDoi } from '../lib/identity';
import { arxivUrl, doiUrl, venueLine } from '../lib/format';
import { AbortedError, ApiError, NetworkError, NotFoundError, RateLimitedError } from './errors';
import { parseRetryAfter } from './s2';
import type { EnqueueOptions, RequestQueue } from './queue';

export const ZOTERO_API = 'https://api.zotero.org';
/** Vite-proxied root of the running Zotero app's server (see vite.config.ts). */
export const ZOTERO_LOCAL_ROOT = '/zotero-local';
/** Vite-proxied base of the running Zotero app's read-only local API. */
export const ZOTERO_LOCAL_API = '/zotero-local/api';
/** The local API serves the current user's library as userID 0. */
export const ZOTERO_LOCAL_USER = '0';

export interface ZoteroKeyInfo {
  userID: number;
  username: string;
  canWrite: boolean;
}

export interface ZoteroCreator {
  creatorType: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}

/** The `data` payload of a Zotero item — only the fields we read or write. */
export interface ZoteroItemData {
  itemType: string;
  /** Attachment items only. */
  linkMode?: string;
  parentItem?: string;
  contentType?: string;
  title?: string;
  creators?: ZoteroCreator[];
  abstractNote?: string;
  publicationTitle?: string;
  proceedingsTitle?: string;
  repository?: string;
  archiveID?: string;
  date?: string;
  volume?: string;
  pages?: string;
  DOI?: string;
  url?: string;
  extra?: string;
  collections?: string[];
  tags?: { tag: string }[];
}

export interface ZoteroItem {
  key: string;
  version: number;
  data: ZoteroItemData;
  meta?: { creatorSummary?: string; parsedDate?: string; numChildren?: number };
}

export interface ZoteroCollection {
  key: string;
  name: string;
  /** false at the top level, otherwise the parent collection's key. */
  parentCollection: string | false;
}

/** What the store needs from a Zotero client (fakes implement this in tests). */
export interface ZoteroLike {
  keyInfo(): Promise<ZoteroKeyInfo>;
  searchItems(userId: string, q: string, options?: { limit?: number; signal?: AbortSignal }): Promise<ZoteroItem[]>;
  /** Library item exactly matching one of the paper's identifiers, or null. */
  findByIds(userId: string, ids: { doi?: string; arxiv?: string }): Promise<ZoteroItem | null>;
  collections(userId: string): Promise<ZoteroCollection[]>;
  createItem(userId: string, item: ZoteroItemData): Promise<{ key: string }>;
}

interface ZoteroKeyRaw {
  key?: string;
  userID: number;
  username?: string;
  access?: { user?: { library?: boolean; write?: boolean } };
}

interface ZoteroCollectionRaw {
  key: string;
  data?: { name?: string; parentCollection?: string | false };
}

interface ZoteroWriteResponse {
  successful?: Record<string, { key?: string }>;
  failed?: Record<string, { code?: number; message?: string }>;
}

export interface ZoteroClientOptions {
  queue: RequestQueue;
  fetchFn?: typeof fetch;
  /** Fixed base, or a getter so the base can follow a settings value (local bridge URL). */
  baseUrl?: string | (() => string);
  getApiKey: () => string;
  /** Sent on every request. The local client uses this for Zotero's stock `Zotero-Allowed-Request` gate bypass. */
  extraHeaders?: Record<string, string>;
}

const COLLECTION_PAGE = 100;

export class ZoteroClient implements ZoteroLike {
  private readonly queue: RequestQueue;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | (() => string);
  private readonly getApiKey: () => string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: ZoteroClientOptions) {
    this.queue = options.queue;
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.baseUrl = options.baseUrl ?? ZOTERO_API;
    this.getApiKey = options.getApiKey;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  private base(): string {
    return typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl;
  }

  /** Who does this key belong to? `/keys/current` is what Zotero's own web library uses; older docs only list `/keys/<key>`. */
  async keyInfo(): Promise<ZoteroKeyInfo> {
    let raw: ZoteroKeyRaw;
    try {
      raw = await this.request<ZoteroKeyRaw>('zotero:key:current', '/keys/current');
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      raw = await this.request<ZoteroKeyRaw>('zotero:key:fallback', `/keys/${encodeURIComponent(this.getApiKey())}`);
    }
    return {
      userID: raw.userID,
      username: raw.username ?? '',
      canWrite: raw.access?.user?.write === true,
    };
  }

  /** Quick-search top-level items (excludes attachments/notes). */
  searchItems(userId: string, q: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<ZoteroItem[]> {
    const limit = options.limit ?? 20;
    return this.request<ZoteroItem[]>(`zotero:search:${userId}:${limit}:${q}`, `/users/${userId}/items/top`, {
      params: { q, qmode: 'titleCreatorYear', limit: String(limit), sort: 'dateModified', direction: 'desc' },
      signal: options.signal,
    });
  }

  /** Exact-DOI membership check (quick-search can return full-text false positives, hence the normDoi filter). */
  private async findByDoi(userId: string, doi: string): Promise<ZoteroItem | null> {
    const items = await this.request<ZoteroItem[]>(`zotero:doi:${userId}:${doi}`, `/users/${userId}/items`, {
      params: { q: doi, qmode: 'everything', itemType: '-attachment', limit: '5' },
    });
    const want = normDoi(doi);
    return items.find((i) => i.data.DOI && normDoi(i.data.DOI) === want) ?? null;
  }

  /**
   * Membership by any exact identifier. The DOI check misses preprint items (they carry the
   * arXiv id in archiveID/Extra, often with no DOI field), so arXiv ids get their own query,
   * verified via lookupFromZoteroItem so full-text mentions of the id don't count.
   */
  async findByIds(userId: string, ids: { doi?: string; arxiv?: string }): Promise<ZoteroItem | null> {
    if (ids.doi) {
      const hit = await this.findByDoi(userId, ids.doi);
      if (hit) return hit;
    }
    if (ids.arxiv) {
      const want = `arxiv:${normArxiv(ids.arxiv)}`;
      const items = await this.request<ZoteroItem[]>(`zotero:arxiv:${userId}:${ids.arxiv}`, `/users/${userId}/items`, {
        params: { q: ids.arxiv, qmode: 'everything', itemType: '-attachment', limit: '5' },
      });
      for (const item of items) {
        const lookup = lookupFromZoteroItem(item);
        if (lookup && lookup.toLowerCase() === want) return item;
      }
    }
    return null;
  }

  async collections(userId: string): Promise<ZoteroCollection[]> {
    const all: ZoteroCollection[] = [];
    for (let start = 0; ; start += COLLECTION_PAGE) {
      const page = await this.request<ZoteroCollectionRaw[]>(`zotero:collections:${userId}:${start}`, `/users/${userId}/collections`, {
        params: { limit: String(COLLECTION_PAGE), start: String(start) },
      });
      for (const c of page) all.push({ key: c.key, name: c.data?.name ?? '', parentCollection: c.data?.parentCollection ?? false });
      if (page.length < COLLECTION_PAGE) return all;
    }
  }

  async createItem(userId: string, item: ZoteroItemData): Promise<{ key: string }> {
    // One token per logical create: queue retries re-send it, so Zotero never files duplicates.
    const token = makeWriteToken();
    const res = await this.request<ZoteroWriteResponse>(`zotero:create:${token}`, `/users/${userId}/items`, {
      method: 'POST',
      body: [item],
      headers: { 'Zotero-Write-Token': token },
    });
    const key = res.successful?.['0']?.key;
    if (key) return { key };
    const fail = res.failed?.['0'];
    throw new ApiError(fail?.code ?? 500, fail?.message ?? 'Zotero did not save the item', res, 'zotero');
  }

  private request<T>(
    key: string,
    path: string,
    options: { params?: Record<string, string>; method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; priority?: number } = {},
  ): Promise<T> {
    const enqueue: EnqueueOptions = { priority: options.priority, signal: options.signal };
    return this.queue.enqueue<T>(
      key,
      async (signal) => {
        const qs = options.params ? `?${new URLSearchParams(options.params).toString()}` : '';
        const url = `${this.base()}${path}${qs}`;
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'Zotero-API-Version': '3',
          ...this.extraHeaders,
          ...options.headers,
        };
        const apiKey = this.getApiKey();
        if (apiKey) headers['Zotero-API-Key'] = apiKey;
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method: options.method ?? 'GET',
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal,
          });
        } catch (e) {
          if (signal.aborted) throw new AbortedError();
          throw new NetworkError(e instanceof Error ? e.message : 'Network error', 'zotero');
        }
        if (res.status === 429 || res.status === 503) {
          throw new RateLimitedError(parseRetryAfter(res.headers.get('retry-after')), 'Rate limited', await safeBody(res), 'zotero');
        }
        if (res.status === 404) throw new NotFoundError('Not found', await safeBody(res), 'zotero');
        if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, await safeBody(res), 'zotero');
        return (await res.json()) as T;
      },
      enqueue,
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

/** Translator-style creator used by the connector endpoints (`fieldMode: 1` = single-field name). */
export interface ZoteroConnectorCreator {
  firstName?: string;
  lastName: string;
  fieldMode?: number;
  creatorType: string;
}

/** Item payload for `/connector/saveItems` — like ZoteroItemData but translator-flavoured. */
export interface ZoteroConnectorItem extends Omit<ZoteroItemData, 'collections' | 'creators'> {
  /** Client-generated handle that saveAttachment's parentItemID refers back to. */
  id?: string;
  creators: ZoteroConnectorCreator[];
  attachments: unknown[];
}

/** What the store needs from the connector write path (fakes implement this in tests). */
export interface ZoteroConnectorLike {
  saveItem(item: ZoteroConnectorItem, uri: string, pdfUrl?: string): Promise<{ pdfAttached: boolean }>;
}

/**
 * Keyless writes into the RUNNING Zotero app via its connector endpoint (the same one the
 * browser extension uses). Items are filed into the collection currently selected in Zotero.
 */
export class ZoteroConnectorClient implements ZoteroConnectorLike {
  private readonly queue: RequestQueue;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | (() => string);

  constructor(options: { queue: RequestQueue; fetchFn?: typeof fetch; baseUrl?: string | (() => string) }) {
    this.queue = options.queue;
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
    this.baseUrl = options.baseUrl ?? ZOTERO_LOCAL_ROOT;
  }

  private base(): string {
    return typeof this.baseUrl === 'function' ? this.baseUrl() : this.baseUrl;
  }

  /**
   * Save the item; when `pdfUrl` is given, additionally download the PDF in the browser and
   * upload it as a child attachment (the modern connector contract — Zotero no longer fetches
   * attachment URLs itself). The PDF is best-effort: CORS or download failures still leave the
   * item saved, reported as `pdfAttached: false`.
   */
  async saveItem(item: ZoteroConnectorItem, uri: string, pdfUrl?: string): Promise<{ pdfAttached: boolean }> {
    const sessionID = makeWriteToken();
    const itemId = makeWriteToken();
    return this.queue.enqueue<{ pdfAttached: boolean }>(
      `zotero:connector:${sessionID}`,
      async (signal) => {
        let res: Response;
        try {
          res = await this.fetchFn(`${this.base()}/connector/saveItems`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Zotero-Connector-API-Version': '3' },
            body: JSON.stringify({ sessionID, uri, items: [{ ...item, id: itemId }] }),
            signal,
          });
        } catch (e) {
          if (signal.aborted) throw new AbortedError();
          throw new NetworkError(e instanceof Error ? e.message : 'Network error', 'zotero');
        }
        // Strictly 201: the connector server signals some failures (e.g. a read-only target
        // library) as 200 with a plain-text body, which must not count as saved.
        if (res.status !== 201) throw new ApiError(res.status, `HTTP ${res.status}`, await safeBody(res), 'zotero');
        if (!pdfUrl) return { pdfAttached: false };
        try {
          const pdf = await this.fetchFn(pdfUrl, { signal });
          if (!pdf.ok) return { pdfAttached: false };
          const blob = await pdf.blob();
          const up = await this.fetchFn(`${this.base()}/connector/saveAttachment?sessionID=${sessionID}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/pdf',
              'X-Metadata': JSON.stringify({ sessionID, parentItemID: itemId, title: 'Full Text PDF', url: pdfUrl }),
            },
            body: blob,
            signal,
          });
          return { pdfAttached: up.status === 201 };
        } catch {
          if (signal.aborted) throw new AbortedError();
          return { pdfAttached: false };
        }
      },
      {},
    );
  }
}


/** Connector-flavoured item for a Paper (single-string authors become fieldMode-1 creators). */
export function paperToConnectorItem(p: Paper): ZoteroConnectorItem {
  const { collections: _collections, creators, ...rest } = paperToZoteroItem(p, '');
  return {
    ...rest,
    creators: (creators ?? []).map((c) => ({
      creatorType: c.creatorType,
      lastName: c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' '),
      fieldMode: 1,
    })),
    attachments: [],
  };
}

/** 32-hex idempotency token for Zotero-Write-Token. */
export function makeWriteToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Best identifier of a Zotero item as a seed lookup, or null.
 * Order: DOI field › preprint archiveID › `arXiv:`/`DOI:` lines in Extra (Zotero's convention
 * for item types without those fields) › URL (normalizeLookup parses doi.org/arxiv.org/publisher URLs).
 */
export function lookupFromZoteroItem(item: ZoteroItem): Lookup | null {
  const d = item.data;
  const candidates: string[] = [];
  if (d.DOI) candidates.push(d.DOI);
  if (d.archiveID) candidates.push(d.archiveID);
  for (const line of (d.extra ?? '').split('\n')) {
    const m = /^\s*(arxiv|doi)\s*:\s*(\S+)/i.exec(line);
    if (m) candidates.push(m[1]!.toLowerCase() === 'arxiv' ? `arXiv:${m[2]!}` : m[2]!);
  }
  if (d.url) candidates.push(d.url);
  for (const c of candidates) {
    const lookup = normalizeLookup(c);
    if (lookup) return lookup;
  }
  return null;
}

/**
 * Map our metadata onto a Zotero item, mirroring generateBibtex's type choice:
 * venue + Conference → conferencePaper, venue → journalArticle, arXiv-only → preprint.
 * Only template-known fields — unknown fields make the whole item fail.
 */
export function paperToZoteroItem(p: Paper, collectionKey: string): ZoteroItemData {
  const arxiv = p.externalIds.ArXiv;
  const venue = venueLine({ venue: p.venue, journal: p.journal ? { name: p.journal.name } : null });
  const isConf = p.publicationTypes.includes('Conference');
  const base: Omit<ZoteroItemData, 'itemType'> = {
    title: p.title,
    creators: p.authors.map((a) => ({ creatorType: 'author', name: a.name })),
    date: p.publicationDate ?? (p.year ? String(p.year) : ''),
    DOI: p.externalIds.DOI ?? '',
    url: doiUrl(p) ?? arxivUrl(p) ?? '',
    abstractNote: p.abstract ?? '',
    collections: collectionKey ? [collectionKey] : [],
    tags: [],
  };
  if (!venue && arxiv) {
    return { itemType: 'preprint', ...base, repository: 'arXiv', archiveID: `arXiv:${arxiv}` };
  }
  const extra = arxiv ? `arXiv:${arxiv}` : '';
  if (venue && isConf) {
    return { itemType: 'conferencePaper', ...base, proceedingsTitle: venue, pages: p.journal?.pages ?? '', extra };
  }
  return {
    itemType: 'journalArticle',
    ...base,
    publicationTitle: venue,
    volume: p.journal?.volume ?? '',
    pages: p.journal?.pages ?? '',
    extra,
  };
}
