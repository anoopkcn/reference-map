/** Canonical Semantic Scholar paper id (40-hex sha). The ONLY key used in stores and the graph. */
export type PaperId = string;

/**
 * Anything `/paper/{id}` accepts: a sha, or a prefixed external id such as
 * `DOI:10.1/x`, `ARXIV:2106.15928`, `URL:https://…`, `CorpusId:123`, `PMID:…`, `PMCID:…`, `MAG:…`, `ACL:…`.
 */
export type Lookup = string;

export interface Author {
  authorId: string | null;
  name: string;
}

export interface Journal {
  name?: string;
  volume?: string;
  pages?: string;
}

export type ExternalIdKey = 'DOI' | 'ArXiv' | 'MAG' | 'ACL' | 'PubMed' | 'PubMedCentral' | 'DBLP' | 'CorpusId';
export type ExternalIds = Partial<Record<ExternalIdKey, string>>;

/** How much of a paper we have fetched. Monotonic: merging never downgrades. */
export type DetailLevel = 'search' | 'list' | 'full';
export const DETAIL_RANK: Record<DetailLevel, number> = { search: 0, list: 1, full: 2 };

export interface Paper {
  paperId: PaperId;
  title: string;
  year: number | null;
  authors: Author[];
  venue: string;
  journal: Journal | null;
  citationCount: number;
  referenceCount: number;
  influentialCitationCount: number;
  externalIds: ExternalIds;
  isOpenAccess: boolean;
  openAccessPdf: { url: string; status?: string } | null;
  publicationTypes: string[];
  publicationDate: string | null;
  /** Only present at detailLevel 'full'. `null` = fetched but S2 has none. */
  abstract?: string | null;
  bibtex?: string | null;
  detailLevel: DetailLevel;
  fetchedAt: number;
}

export type SeedStatus = 'resolving' | 'ready' | 'error';
export interface Seed {
  lookup: Lookup;
  paperId: PaperId | null;
  status: SeedStatus;
  error?: string;
}

export type ListKind = 'refs' | 'cites';
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface ListState {
  ids: PaperId[];
  status: LoadStatus;
  /** Total count reported by S2 (may exceed ids.length when capped by listLimit). */
  total: number | null;
  error?: string;
}

export const NodeRole = { Seed: 0, Cited: 1, Citing: 2, Both: 3, Isolated: 4 } as const;
export type NodeRole = (typeof NodeRole)[keyof typeof NodeRole];

export type SortKey = 'year' | 'citationCount' | 'referenceCount' | 'influentialCitationCount';
export type SortDir = 'asc' | 'desc';
export const SORT_KEYS: { key: SortKey; label: string }[] = [
  { key: 'year', label: 'Year' },
  { key: 'citationCount', label: 'Citations' },
  { key: 'referenceCount', label: 'References' },
  { key: 'influentialCitationCount', label: 'Influential' },
];

export type LabelMode = 'seeds' | 'auto' | 'all';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  apiKey: string;
  /** refs/cites fetched per paper (≤ 1000). */
  listLimit: number;
  /** New nodes added per direction per expansion. */
  graphExpandLimit: number;
  /** Fetch refs+cites of seeds automatically to build the first ring of the map. */
  autoExpandSeeds: boolean;
  labelMode: LabelMode;
  theme: Theme;
  sortKey: SortKey;
  sortDir: SortDir;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  listLimit: 500,
  graphExpandLimit: 100,
  autoExpandSeeds: true,
  labelMode: 'auto',
  theme: 'system',
  sortKey: 'citationCount',
  sortDir: 'desc',
};

export const S2_WEB = 'https://www.semanticscholar.org';
export const S2_API = 'https://api.semanticscholar.org/graph/v1';
