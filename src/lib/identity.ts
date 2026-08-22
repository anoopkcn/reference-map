import type { ExternalIds, Lookup, Paper, PaperId, PaperSources } from '../types';

/** Normalised alias key: 'doi:…' 'arxiv:…' 'pmid:…' 'mag:…' 's2:…' 'oa:W…' 'pmcid:…' 'corpusid:…' 'acl:…' 'dblp:…' 'url:…'. */
export type AliasKey = string;

/** A cached alias entry: canonical id, or null for a negative (not found) entry. */
export interface AliasEntry {
  paperId: PaperId | null;
  fetchedAt: number;
}

export interface AliasStore {
  getLookups(keys: readonly string[]): Promise<Map<string, AliasEntry>>;
  putLookup(key: string, v: AliasEntry): Promise<void>;
  putLookups(entries: readonly (readonly [string, AliasEntry])[]): Promise<void>;
}

/** Canonical id kinds, most preferred first. */
export const CANON_PRIORITY = ['doi', 'arxiv', 'pmid', 'mag', 's2', 'oa'] as const;
const CANON_RE = /^(doi|arxiv|pmid|mag|s2|oa):/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const DATACITE_ARXIV_RE = /^10\.48550\/arxiv\.(.+)$/i;

export function isCanonicalId(id: string): boolean {
  return CANON_RE.test(id);
}

/** Lower-cased DOI without any `https://doi.org/` prefix or `doi:` label. */
export function normDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

/** arXiv id without version, lower-cased (old-style ids carry a category prefix). */
export function normArxiv(id: string): string {
  return id.trim().replace(/^arxiv:\s*/i, '').replace(/v\d+$/i, '').toLowerCase();
}

/** `10.48550/arXiv.1706.03762` → `1706.03762`; null for other DOIs. */
export function arxivFromDoi(doi: string): string | null {
  const m = DATACITE_ARXIV_RE.exec(normDoi(doi));
  return m ? normArxiv(m[1]!) : null;
}

/** Alias keys for a paper: `canon` (eligible to be the canonical id, in priority order) and `extra` (aliases only). */
export function keysOf(p: { externalIds: ExternalIds; sources: PaperSources }): { canon: AliasKey[]; extra: AliasKey[] } {
  const canon: AliasKey[] = [];
  const extra: AliasKey[] = [];
  const x = p.externalIds;
  const doiArxiv = x.DOI ? arxivFromDoi(x.DOI) : null;
  const arxiv = x.ArXiv ? normArxiv(x.ArXiv) : doiArxiv;
  if (x.DOI) {
    if (doiArxiv) extra.push(`doi:${normDoi(x.DOI)}`); // DataCite arXiv DOIs are aliases only
    else canon.push(`doi:${normDoi(x.DOI)}`);
  }
  if (arxiv) canon.push(`arxiv:${arxiv}`);
  if (x.PubMed) canon.push(`pmid:${x.PubMed}`);
  if (x.MAG) canon.push(`mag:${x.MAG}`);
  if (p.sources.s2) canon.push(`s2:${p.sources.s2.toLowerCase()}`);
  if (p.sources.openalex) canon.push(`oa:${p.sources.openalex.toUpperCase()}`);
  if (x.PubMedCentral) extra.push(`pmcid:${x.PubMedCentral.replace(/^PMC/i, '')}`);
  if (x.CorpusId) extra.push(`corpusid:${x.CorpusId}`);
  if (x.ACL) extra.push(`acl:${x.ACL.toLowerCase()}`);
  if (x.DBLP) extra.push(`dblp:${x.DBLP.toLowerCase()}`);
  return { canon, extra };
}

/** Normalise a user/URL lookup (or canonical id) to its alias key; null if unrecognised. */
export function lookupToAliasKey(lookup: Lookup): AliasKey | null {
  const t = lookup.trim();
  if (SHA_RE.test(t)) return `s2:${t.toLowerCase()}`;
  const m = /^([a-z0-9]+)\s*:\s*(\S.*)$/i.exec(t);
  if (!m) return null;
  const kind = m[1]!.toLowerCase();
  const v = m[2]!.trim();
  switch (kind) {
    case 'doi': {
      const ax = arxivFromDoi(v);
      return ax ? `arxiv:${ax}` : `doi:${normDoi(v)}`;
    }
    case 'arxiv':
      return `arxiv:${normArxiv(v)}`;
    case 'pmid':
      return `pmid:${v}`;
    case 'pmcid':
      return `pmcid:${v.replace(/^PMC/i, '')}`;
    case 'mag':
      return `mag:${v}`;
    case 'corpusid':
      return `corpusid:${v}`;
    case 'acl':
      return `acl:${v.toLowerCase()}`;
    case 'url':
      return `url:${v.toLowerCase()}`;
    case 's2':
      return SHA_RE.test(v) ? `s2:${v.toLowerCase()}` : null;
    case 'oa':
    case 'openalex':
      return /^W\d+$/i.test(v) ? `oa:${v.toUpperCase()}` : null;
    case 'dblp':
      return `dblp:${v.toLowerCase()}`;
    default:
      return null;
  }
}

/** Canonical id from the highest-priority canon key. */
function mint(canon: AliasKey[]): PaperId {
  for (const kind of CANON_PRIORITY) {
    const k = canon.find((c) => c.startsWith(kind + ':'));
    if (k) return k;
  }
  return canon[0]!;
}

/**
 * Provider-neutral identity: maps every known id form of a paper to ONE canonical PaperId.
 * Memory-first, persisted through the cache's lookups store. A canonical id never changes once minted.
 */
export class Identity {
  private mem = new Map<AliasKey, AliasEntry>();
  readonly stats = { minted: 0, merged: 0, conflicts: 0 };

  constructor(
    private cache: AliasStore,
    private now: () => number = () => Date.now(),
  ) {}

  setCache(c: AliasStore): void {
    this.cache = c;
  }

  peek(key: AliasKey): AliasEntry | undefined {
    return this.mem.get(key);
  }

  /** Memory → cache. Returns undefined when unknown; `paperId: null` marks a negative entry. */
  async resolve(key: AliasKey): Promise<AliasEntry | undefined> {
    const m = this.mem.get(key);
    if (m) return m;
    const found = (await this.cache.getLookups([key])).get(key);
    if (found) this.mem.set(key, found);
    return found;
  }

  alias(key: AliasKey, id: PaperId): void {
    const e = { paperId: id, fetchedAt: this.now() };
    this.mem.set(key, e);
    void this.cache.putLookup(key, e);
  }

  aliasMany(entries: readonly (readonly [AliasKey, PaperId])[]): void {
    const writes: [AliasKey, AliasEntry][] = [];
    for (const [key, id] of entries) {
      const e = { paperId: id, fetchedAt: this.now() };
      this.mem.set(key, e);
      writes.push([key, e]);
    }
    void this.cache.putLookups(writes);
  }

  negative(key: AliasKey): void {
    const e = { paperId: null, fetchedAt: this.now() };
    this.mem.set(key, e);
    void this.cache.putLookup(key, e);
  }


  negativeMany(keys: readonly AliasKey[]): void {
    const writes: [AliasKey, AliasEntry][] = [];
    for (const key of keys) {
      const e = { paperId: null, fetchedAt: this.now() };
      this.mem.set(key, e);
      writes.push([key, e]);
    }
    void this.cache.putLookups(writes);
  }

  /**
   * Canonicalise papers in place: reuse an existing canonical id if any key is known, else mint by priority.
   * Registers every key as an alias (never overwriting). Papers without any ids pass through unchanged.
   */
  async assign<T extends Paper>(papers: readonly T[]): Promise<T[]> {
    const keyed = papers.map((p) => ({ p, ...keysOf(p) }));
    const missing = new Set<AliasKey>();
    for (const k of keyed) for (const key of [...k.canon, ...k.extra]) if (!this.mem.has(key)) missing.add(key);
    if (missing.size) {
      const found = await this.cache.getLookups([...missing]);
      for (const [k, v] of found) this.mem.set(k, v);
    }
    const writes = new Map<AliasKey, AliasEntry>();
    for (const { p, canon, extra } of keyed) {
      if (canon.length === 0) continue;
      let id: PaperId | undefined;
      for (const k of canon) {
        const e = this.mem.get(k);
        if (e && e.paperId) {
          id = e.paperId;
          break;
        }
      }
      if (id) this.stats.merged++;
      else {
        id = mint(canon);
        this.stats.minted++;
      }
      for (const k of [...canon, ...extra]) {
        const e = this.mem.get(k);
        if (!e || e.paperId === null) {
          const entry = { paperId: id, fetchedAt: this.now() };
          this.mem.set(k, entry);
          writes.set(k, entry);
        }
        else if (e.paperId !== id) this.stats.conflicts++;
      }
      (p as Paper).paperId = id;
    }
    if (writes.size) await this.cache.putLookups([...writes]);
    return papers as T[];
  }
}
