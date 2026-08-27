import { OPENALEX_WEB, S2_WEB, type Author, type Paper, type PaperId } from '../types';

export function s2PaperUrl(id: PaperId): string {
  return `${S2_WEB}/paper/${id}`;
}

export function s2AuthorUrl(authorId: string): string {
  return `${S2_WEB}/author/${authorId}`;
}

export function doiUrl(p: Pick<Paper, 'externalIds'>): string | null {
  const doi = p.externalIds.DOI;
  return doi ? `https://doi.org/${doi}` : null;
}

export function arxivUrl(p: Pick<Paper, 'externalIds'>): string | null {
  const id = p.externalIds.ArXiv;
  return id ? `https://arxiv.org/abs/${id}` : null;
}

/**
 * Best full-text PDF. arXiv's canonical PDF wins whenever the paper has an arXiv id: the
 * providers' open-access links are occasionally misattributed upstream (e.g. an institutional-
 * repository document that merely cites the paper), while arxiv.org/pdf/<id> is always the paper.
 */
export function pdfUrl(p: Pick<Paper, 'externalIds' | 'openAccessPdf'>): string | null {
  const arxiv = p.externalIds.ArXiv;
  if (arxiv) return `https://arxiv.org/pdf/${arxiv}`;
  return p.openAccessPdf?.url || null;
}

/**
 * Best page for opening a paper from the UI.
 *
 * Prefer the provider record that supplied the displayed metadata. DOI targets can be
 * stale or broken at the publisher even while the provider record remains available.
 * The DOI is still exposed separately and remains preferred in copied citations.
 */
export function paperUrl(p: Pick<Paper, 'externalIds' | 'sources'>): string | null {
  return (
    (p.sources.s2 ? s2PaperUrl(p.sources.s2) : null) ??
    (p.sources.openalex ? `${OPENALEX_WEB}/${p.sources.openalex}` : null) ??
    doiUrl(p) ??
    arxivUrl(p)
  );
}

/** Human label for where paperUrl points. */
export function paperUrlLabel(p: Pick<Paper, 'externalIds' | 'sources'>): string {
  if (p.sources.s2) return 'Open on Semantic Scholar';
  if (p.sources.openalex) return 'Open on OpenAlex';
  if (p.externalIds.DOI) return 'Open via DOI';
  if (p.externalIds.ArXiv) return 'Open on arXiv';
  return '';
}

export function authorUrl(a: Author): string | null {
  if (!a.authorId) return null;
  return a.provider === 'openalex' ? `${OPENALEX_WEB}/${a.authorId}` : s2AuthorUrl(a.authorId);
}

/** Last token of a name ("Ashish Vaswani" → "Vaswani"). */
export function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

/** "A, B, C" or "A, B, C et al." when more than `max` authors. */
export function authorsLine(authors: Author[], max = Infinity): string {
  if (authors.length === 0) return '';
  if (authors.length <= max) return authors.map((a) => a.name).join(', ');
  return authors.slice(0, max).map((a) => a.name).join(', ') + ' et al.';
}

/** Short label for graph nodes: "Vaswani et al. 2017". */
export function nodeLabel(p: Pick<Paper, 'authors' | 'year' | 'title'>): string {
  const first = p.authors[0];
  const who = first ? surname(first.name) + (p.authors.length > 1 ? ' et al.' : '') : truncate(p.title, 32);
  return p.year ? `${who} ${p.year}` : who;
}

/** "Journal, vol, pages" — falls back to venue; omits missing parts instead of printing sentinels (no name → nothing). */
export function venueLine(p: Pick<Paper, 'venue' | 'journal'>): string {
  const name = p.journal?.name?.trim() || p.venue?.trim() || '';
  if (!name) return '';
  const parts = [name, p.journal?.volume?.trim(), p.journal?.pages?.trim()].filter((s): s is string => !!s);
  return parts.join(', ');
}

/** Plain-text citation suitable for pasting. */
export function plainCitation(p: Paper): string {
  const authors = authorsLine(p.authors, 6);
  const year = p.year ? ` (${p.year})` : '';
  const venue = venueLine(p);
  const link = doiUrl(p) ?? arxivUrl(p) ?? paperUrl(p) ?? '';
  return [`${authors}${year}.`, `${p.title}.`, venue ? `${venue}.` : '', link].filter(Boolean).join(' ');
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

/** 12345 → "12.3k", 1234567 → "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** Human label for S2 publication types ("JournalArticle" → "Journal Article"). */
export function pubTypeLabel(t: string): string {
  return t.replace(/([a-z])([A-Z])/g, '$1 $2');
}
