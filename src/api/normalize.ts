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

/** Convert a raw S2 paper to our Paper (provisional id `s2:<sha>`). Returns null when the record has no paperId. */
export function normalizePaper(raw: S2PaperRaw | null | undefined, level: DetailLevel, now = Date.now()): Paper | null {
  if (!raw || !raw.paperId) return null;
  const authors: Author[] = (raw.authors ?? [])
    .filter((a): a is { authorId?: string | null; name?: string | null } => !!a && !!a.name)
    .map((a) => ({ authorId: a.authorId ?? null, name: a.name!.trim(), provider: 's2' }));
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
    paperId: `s2:${raw.paperId}`,
    sources: { s2: raw.paperId },
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
 * Merge a newly fetched record into an existing one for the same paper (possibly from another provider).
 * - The canonical `paperId` of `prev` is kept; `sources` / `externalIds` are unioned.
 * - Detail never downgrades: a 'list' fetch refreshes metadata but keeps an earlier abstract/BibTeX.
 * - For metadata and counts, Semantic Scholar wins when it is known; OpenAlex fills the blanks.
 */
export function mergePaper(prev: Paper | undefined, next: Paper): Paper {
  if (!prev) return next;
  const nextIsS2 = !!next.sources.s2 && !next.sources.openalex;
  const prevHasS2 = !!prev.sources.s2;
  const preferNext = nextIsS2 || !prevHasS2;
  const base = preferNext ? next : prev;
  const other = preferNext ? prev : next;
  const s2Rec = nextIsS2 ? next : prevHasS2 ? prev : null;
  const merged: Paper = {
    ...base,
    paperId: prev.paperId,
    sources: { ...prev.sources, ...next.sources },
    externalIds: { ...other.externalIds, ...base.externalIds },
    detailLevel: DETAIL_RANK[next.detailLevel] >= DETAIL_RANK[prev.detailLevel] ? next.detailLevel : prev.detailLevel,
    fetchedAt: Math.max(prev.fetchedAt, next.fetchedAt),
    title: base.title && base.title !== 'Untitled' ? base.title : other.title,
    year: base.year ?? other.year,
    authors: base.authors.length ? base.authors : other.authors,
    venue: base.venue || other.venue,
    journal: base.journal ?? other.journal,
    isOpenAccess: base.isOpenAccess || other.isOpenAccess,
    openAccessPdf: base.openAccessPdf ?? other.openAccessPdf,
    publicationTypes: base.publicationTypes.length ? base.publicationTypes : other.publicationTypes,
    publicationDate: base.publicationDate ?? other.publicationDate,
    influentialCitationCount: s2Rec ? s2Rec.influentialCitationCount : null,
  };
  // abstract / bibtex: a defined value wins (null = fetched but none); S2's BibTeX preferred.
  const abstract = base.abstract ?? other.abstract;
  if (abstract !== undefined) merged.abstract = abstract;
  else delete merged.abstract;
  const bibtex = (s2Rec?.bibtex ?? null) || base.bibtex || other.bibtex;
  if (bibtex) merged.bibtex = bibtex;
  else if (base.bibtex !== undefined || other.bibtex !== undefined) merged.bibtex = null;
  else delete merged.bibtex;
  return merged;
}

/** True when a provider has already lost one or more Unicode characters while decoding metadata. */
export function hasUnicodeReplacement(paper: Paper): boolean {
  return (
    paper.title.includes('\uFFFD') ||
    paper.authors.some((author) => author.name.includes('\uFFFD')) ||
    paper.venue.includes('\uFFFD') ||
    (!!paper.journal && Object.values(paper.journal).some((value) => value?.includes('\uFFFD')))
  );
}

/**
 * Repair only damaged text with a clean copy from another provider.
 * The primary record keeps its richer metadata, counts, and provider-native author ids.
 */
export function repairUnicodeMetadata(primary: Paper, fallback: Paper): Paper {
  const clean = (value: string | undefined): value is string => !!value && !value.includes('\uFFFD');
  const repair = (value: string, replacement: string | undefined): string =>
    value.includes('\uFFFD') && clean(replacement) ? replacement : value;
  const fallbackJournal = fallback.journal;
  const journal = primary.journal
    ? {
        ...primary.journal,
        ...(primary.journal.name?.includes('\uFFFD') && clean(fallbackJournal?.name) ? { name: fallbackJournal.name } : {}),
        ...(primary.journal.volume?.includes('\uFFFD') && clean(fallbackJournal?.volume) ? { volume: fallbackJournal.volume } : {}),
        ...(primary.journal.pages?.includes('\uFFFD') && clean(fallbackJournal?.pages) ? { pages: fallbackJournal.pages } : {}),
      }
    : primary.journal;

  return {
    ...primary,
    sources: { ...primary.sources, ...fallback.sources },
    externalIds: { ...primary.externalIds, ...fallback.externalIds },
    title: repair(primary.title, fallback.title),
    authors: primary.authors.map((author, index) => ({
      ...author,
      name: repair(author.name, fallback.authors[index]?.name),
    })),
    venue: repair(primary.venue, fallback.venue),
    journal,
    influentialCitationCount: primary.influentialCitationCount ?? fallback.influentialCitationCount,
    fetchedAt: Math.max(primary.fetchedAt, fallback.fetchedAt),
  };
}
