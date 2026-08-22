import { DETAIL_RANK, type Author, type DetailLevel, type ExternalIds, type Journal, type Paper } from '../types';

/** Raw shape of a paper object from the S2 Graph API (all fields optional). */
export interface S2PaperRaw {
  paperId?: string | null;
  title?: string | null;
  year?: number | null;
  authors?: { authorId?: string | null; name?: string | null }[] | null;
  venue?: string | null;
  journal?: { name?: string | null; volume?: string | null; pages?: string | null } | null;
  citationCount?: number | null;
  referenceCount?: number | null;
  influentialCitationCount?: number | null;
  externalIds?: Record<string, string | number | null> | null;
  isOpenAccess?: boolean | null;
  openAccessPdf?: { url?: string | null; status?: string | null } | null;
  publicationTypes?: string[] | null;
  publicationDate?: string | null;
  abstract?: string | null;
  citationStyles?: { bibtex?: string | null } | null;
  url?: string | null;
}

const EXTERNAL_KEYS = ['DOI', 'ArXiv', 'MAG', 'ACL', 'PubMed', 'PubMedCentral', 'DBLP', 'CorpusId'] as const;

/** Convert a raw S2 paper to our Paper. Returns null when the record has no paperId. */
export function normalizePaper(raw: S2PaperRaw | null | undefined, level: DetailLevel, now = Date.now()): Paper | null {
  if (!raw || !raw.paperId) return null;
  const authors: Author[] = (raw.authors ?? [])
    .filter((a): a is { authorId?: string | null; name?: string | null } => !!a && !!a.name)
    .map((a) => ({ authorId: a.authorId ?? null, name: a.name!.trim() }));
  const externalIds: ExternalIds = {};
  if (raw.externalIds) {
    for (const k of EXTERNAL_KEYS) {
      const v = raw.externalIds[k];
      if (v !== undefined && v !== null && v !== '') externalIds[k] = String(v);
    }
  }
  let journal: Journal | null = null;
  if (raw.journal && (raw.journal.name || raw.journal.volume || raw.journal.pages)) {
    journal = {};
    if (raw.journal.name) journal.name = raw.journal.name;
    if (raw.journal.volume) journal.volume = raw.journal.volume;
    if (raw.journal.pages) journal.pages = raw.journal.pages;
  }
  const p: Paper = {
    paperId: raw.paperId,
    title: (raw.title ?? '').trim() || 'Untitled',
    year: typeof raw.year === 'number' ? raw.year : null,
    authors,
    venue: (raw.venue ?? '').trim(),
    journal,
    citationCount: raw.citationCount ?? 0,
    referenceCount: raw.referenceCount ?? 0,
    influentialCitationCount: raw.influentialCitationCount ?? 0,
    externalIds,
    isOpenAccess: !!raw.isOpenAccess,
    openAccessPdf: raw.openAccessPdf?.url ? { url: raw.openAccessPdf.url, ...(raw.openAccessPdf.status ? { status: raw.openAccessPdf.status } : {}) } : null,
    publicationTypes: raw.publicationTypes ?? [],
    publicationDate: raw.publicationDate ?? null,
    detailLevel: level,
    fetchedAt: now,
  };
  if (level === 'full') {
    p.abstract = raw.abstract ?? null;
    p.bibtex = raw.citationStyles?.bibtex ?? null;
  }
  return p;
}

/**
 * Merge a newly fetched record into an existing one. Never downgrades detail: a 'list'-level fetch
 * refreshes counts/metadata but keeps the abstract/bibtex of an earlier 'full' fetch.
 */
export function mergePaper(prev: Paper | undefined, next: Paper): Paper {
  if (!prev) return next;
  if (DETAIL_RANK[next.detailLevel] >= DETAIL_RANK[prev.detailLevel]) return next;
  const merged: Paper = { ...next, detailLevel: prev.detailLevel };
  if (prev.abstract !== undefined) merged.abstract = prev.abstract;
  if (prev.bibtex !== undefined) merged.bibtex = prev.bibtex;
  return merged;
}
