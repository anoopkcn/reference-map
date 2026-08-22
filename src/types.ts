/**
 * Canonical, provider-neutral paper id — the ONLY key used in stores and the graph.
 * Minted from external ids by priority: `doi:<lowercase>` › `arxiv:<id>` › `pmid:<n>` › `mag:<n>` › `s2:<sha>` › `oa:W…`.
 * Stable once minted (see lib/identity.ts).
 */
export type PaperId = string;

/**
 * Anything the user (or URL) can hand us: `DOI:10.1/x`, `ARXIV:2106.15928`, `URL:https://…`, `CorpusId:123`,
 * `PMID:…`, `PMCID:…`, `MAG:…`, `ACL:…`, a bare S2 sha, `s2:<sha>`, `oa:W123`, or any canonical PaperId.
 */
export type Lookup = string;

export type ProviderId = 's2' | 'openalex';
export const PROVIDER_LABEL: Record<ProviderId, string> = { s2: 'Semantic Scholar', openalex: 'OpenAlex' };
export const PROVIDER_SHORT: Record<ProviderId, string> = { s2: 'S2', openalex: 'OA' };

export interface Author {
  authorId: string | null;
  name: string;
  /** Which site `authorId` belongs to (default: Semantic Scholar). */
  provider?: ProviderId;
}

/** Native ids of this paper at each provider (for follow-up calls). */
export interface PaperSources {
  s2?: string;
  openalex?: string;
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
  sources: PaperSources;
  title: string;
  year: number | null;
  authors: Author[];
  venue: string;
  journal: Journal | null;
  citationCount: number;
  referenceCount: number;
  /** Semantic Scholar metric; null = unknown (paper only seen via OpenAlex). */
  influentialCitationCount: number | null;
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
  /** Total count reported by the provider (may exceed ids.length when capped by listLimit). */
  total: number | null;
  error?: string;
  /** Which provider supplied the list. */
  provider?: ProviderId;
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
/** auto = adaptive routing between providers; otherwise force one. */
export type SourceMode = 'auto' | 's2' | 'openalex';

export interface Settings {
  /** Semantic Scholar API key (optional). */
  apiKey: string;
  /** Contact e-mail for OpenAlex's polite pool (optional). */
  openalexEmail: string;
  sourceMode: SourceMode;
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
  openalexEmail: '',
  sourceMode: 'auto',
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
export const OPENALEX_WEB = 'https://openalex.org';
export const OPENALEX_API = 'https://api.openalex.org';
