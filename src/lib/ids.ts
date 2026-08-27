import type { Lookup } from '../types';
import { arxivFromDoi } from './identity';

/** Result of parsing what the user typed/pasted into the seed box. */
export type ParsedInput =
  | { kind: 'ids'; lookups: Lookup[]; rejected: string[] }
  | { kind: 'search'; query: string }
  | { kind: 'empty' };

const SHA_RE = /^[0-9a-f]{40}$/i;
const PREFIX_RE = /^(corpusid|pmid|pmcid|mag|acl|arxiv|doi|url|s2|oa|openalex)\s*:\s*(\S.*)$/i;
const OPENALEX_W_RE = /^W\d{4,}$/i;
/** DOI anywhere in a string. Permissive tail; trailing punctuation is stripped afterwards. */
const DOI_RE = /(10\.\d{4,9}\/[^\s"']+)/i;
const ARXIV_NEW_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const ARXIV_OLD_RE = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;
const ACL_ID_RE = /^(?:[A-Z]\d{2}-\d{4}|\d{4}\.[a-z0-9-]+\.\d+)$/i;
const URL_LIKE_RE = /^(?:https?:\/\/|www\.)|^[a-z0-9.-]+\.[a-z]{2,}\//i;

const CANONICAL_PREFIX: Record<string, string> = {
  corpusid: 'CorpusId',
  pmid: 'PMID',
  pmcid: 'PMCID',
  mag: 'MAG',
  acl: 'ACL',
  arxiv: 'ARXIV',
  doi: 'DOI',
  url: 'URL',
  s2: 's2',
  oa: 'oa',
  openalex: 'oa',
};

/** Hosts Semantic Scholar accepts for `URL:` lookups. */
export const S2_URL_HOSTS = ['semanticscholar.org', 'arxiv.org', 'aclweb.org', 'acm.org', 'biorxiv.org'];

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith('.' + base);
}

/** Strip trailing prose/markdown punctuation; closers only when unbalanced (DOIs may legitimately end in `)`). */
export function stripTrailingPunctuation(s: string): string {
  let out = s;
  for (;;) {
    const before = out;
    out = out.replace(/[.,;:*_`'"!?]+$/, '');
    const pairs: [string, string][] = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];
    for (const [open, close] of pairs) {
      while (out.endsWith(close) && count(out, close) > count(out, open)) out = out.slice(0, -1);
    }
    if (out === before) return out;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

function extractDoi(s: string): string | null {
  const m = DOI_RE.exec(s);
  if (!m) return null;
  const doi = stripTrailingPunctuation(m[1]!);
  return doi.length > 7 ? doi : null;
}

function normalizeArxiv(v: string): string | null {
  const s = v.trim().replace(/^arxiv\s*:\s*/i, '').replace(/\.pdf$/i, '');
  let m = ARXIV_NEW_RE.exec(s);
  if (m) return m[1]!;
  m = ARXIV_OLD_RE.exec(s);
  if (m) return m[1]!;
  return null;
}

function normalizeUrl(raw: string): Lookup | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }

  if (host === 'doi.org' || host === 'dx.doi.org') {
    const doi = extractDoi(path.slice(1));
    return doi ? doiLookup(doi) : null;
  }
  if (hostMatches(host, 'arxiv.org')) {
    const m = /^\/(?:abs|pdf|html|format|ps)\/(.+?)(?:\.pdf)?\/?$/i.exec(path);
    const id = m ? normalizeArxiv(m[1]!) : null;
    return id ? `ARXIV:${id}` : `URL:${u.href}`;
  }
  if (hostMatches(host, 'openalex.org')) {
    const m = /\/(?:works\/)?(W\d{4,})(?:[/?#]|$)/i.exec(path);
    return m ? `oa:${m[1]!.toUpperCase()}` : null;
  }
  if (hostMatches(host, 'semanticscholar.org')) {
    const m = /\/paper\/(?:[^/]+\/)?([0-9a-f]{40})(?:[/?#]|$)/i.exec(path);
    if (m) return m[1]!.toLowerCase();
    const a = /\/arxiv\/(\d{4}\.\d{4,5})/i.exec(path);
    if (a) return `ARXIV:${a[1]}`;
    return `URL:${u.href}`;
  }
  if (host === 'dl.acm.org' || hostMatches(host, 'acm.org')) {
    const doi = extractDoi(path);
    return doi ? `DOI:${doi}` : `URL:${u.href}`;
  }
  if (hostMatches(host, 'biorxiv.org') || hostMatches(host, 'medrxiv.org')) {
    const m = /\/content\/(10\.1101\/[^v/?#]+)/i.exec(path);
    if (m) return `DOI:${stripTrailingPunctuation(m[1]!)}`;
    const doi = extractDoi(path);
    return doi ? `DOI:${doi}` : hostMatches(host, 'biorxiv.org') ? `URL:${u.href}` : null;
  }
  if (host === 'pubmed.ncbi.nlm.nih.gov') {
    const m = /^\/(\d+)/.exec(path);
    return m ? `PMID:${m[1]}` : null;
  }
  if (host === 'ncbi.nlm.nih.gov' || host === 'pmc.ncbi.nlm.nih.gov') {
    const m = /\/articles\/PMC(\d+)/i.exec(path);
    if (m) return `PMCID:${m[1]}`;
    const p = /\/pubmed\/(\d+)/i.exec(path);
    return p ? `PMID:${p[1]}` : null;
  }
  if (hostMatches(host, 'aclanthology.org') || hostMatches(host, 'aclweb.org')) {
    const m = /\/(?:anthology\/)?([A-Z]\d{2}-\d{4}|\d{4}\.[a-z0-9-]+\.\d+)(?:\.pdf)?\/?$/i.exec(path);
    if (m) return `ACL:${m[1]}`;
    return hostMatches(host, 'aclweb.org') ? `URL:${u.href}` : null;
  }
  // Publisher URLs that embed the DOI in the path (springer, wiley, plos, frontiers, …)
  const doi = extractDoi(path + (u.search ? decodeURIComponentSafe(u.search) : ''));
  if (doi) return doiLookup(doi);
  if (S2_URL_HOSTS.some((h) => hostMatches(host, h))) return `URL:${u.href}`;
  return null;
}

/**
 * Lookup for an extracted DOI. DataCite arXiv DOIs (10.48550/arXiv.…) become ARXIV lookups:
 * Semantic Scholar doesn't index papers under them, but both providers can resolve the arXiv id.
 */
function doiLookup(doi: string): Lookup {
  const arxiv = arxivFromDoi(doi);
  return arxiv ? `ARXIV:${arxiv}` : `DOI:${doi}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalize one token to a Semantic Scholar lookup, or null if it is not an identifier. */
export function normalizeLookup(token: string): Lookup | null {
  const t = token.trim();
  if (!t) return null;
  if (SHA_RE.test(t)) return t.toLowerCase();

  const pm = PREFIX_RE.exec(t);
  if (pm) {
    const prefix = CANONICAL_PREFIX[pm[1]!.toLowerCase()]!;
    const value = pm[2]!.trim();
    switch (prefix) {
      case 'DOI': {
        const doi = extractDoi(value);
        return doi ? doiLookup(doi) : null;
      }
      case 'ARXIV': {
        if (URL_LIKE_RE.test(value)) return normalizeUrl(value);
        const id = normalizeArxiv(value);
        return id ? `ARXIV:${id}` : null;
      }
      case 'URL':
        return normalizeUrl(value);
      case 's2':
        return SHA_RE.test(value) ? `s2:${value.toLowerCase()}` : null;
      case 'oa':
        return OPENALEX_W_RE.test(value) ? `oa:${value.toUpperCase()}` : null;
      case 'PMCID':
        return `PMCID:${value.replace(/^PMC/i, '')}`;
      case 'ACL':
        return ACL_ID_RE.test(value) ? `ACL:${value}` : null;
      case 'CorpusId':
      case 'PMID':
      case 'MAG':
        return /^\d+$/.test(value) ? `${prefix}:${value}` : null;
      default:
        return null;
    }
  }

  // arXiv before URL-like: old-style ids such as "math.GT/0309136" look like host/path.
  const arxiv = normalizeArxiv(t);
  if (arxiv) return `ARXIV:${arxiv}`;

  if (URL_LIKE_RE.test(t)) return normalizeUrl(t.split(/\s+/)[0]!);

  if (OPENALEX_W_RE.test(t)) return `oa:${t.toUpperCase()}`;

  const doi = extractDoi(t);
  if (doi) return doiLookup(doi);

  return null;
}

/** Key used to de-duplicate lookups (DOIs and arXiv ids are case-insensitive). */
export function lookupKey(lookup: Lookup): string {
  return lookup.toLowerCase();
}

/**
 * Parse free text from the seed box. Multiple ids may be pasted separated by newlines/commas/spaces.
 * If nothing parses as an id, the whole text becomes a search query.
 */
export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };

  const lines = trimmed.split(/[\n\r,;]+/).map((s) => s.trim()).filter(Boolean);
  const lookups: Lookup[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  const push = (l: Lookup) => {
    const k = lookupKey(l);
    if (!seen.has(k)) {
      seen.add(k);
      lookups.push(l);
    }
  };

  for (const line of lines) {
    // Several space-separated ids on one line?
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      const parsed = words.map(normalizeLookup);
      if (parsed.every((p) => p !== null)) {
        parsed.forEach((p) => push(p!));
        continue;
      }
    }
    // Otherwise the line as a whole ("DOI: 10.1/x", "see https://doi.org/10.1/x please").
    const whole = normalizeLookup(line);
    if (whole) {
      push(whole);
      continue;
    }
    rejected.push(line);
  }

  if (lookups.length === 0) return { kind: 'search', query: trimmed.replace(/\s+/g, ' ') };
  return { kind: 'ids', lookups, rejected };
}

/** Human-friendly form of a lookup for captions ("10.18653/v1/N18-3011", "arXiv:1706.03762", "a1b2c3d4…"). */
export function displayLookup(lookup: Lookup): string {
  if (SHA_RE.test(lookup)) return lookup.slice(0, 10) + '…';
  const i = lookup.indexOf(':');
  if (i < 0) return lookup;
  const prefix = lookup.slice(0, i);
  const value = lookup.slice(i + 1);
  if (prefix === 'DOI' || prefix === 'doi') return value;
  if (prefix === 'ARXIV' || prefix === 'arxiv') return `arXiv:${value}`;
  if (prefix === 'URL' || prefix === 'url') return value.replace(/^https?:\/\/(www\.)?/, '');
  if (prefix === 's2') return value.slice(0, 10) + '…';
  if (prefix === 'oa') return value;
  return lookup;
}
