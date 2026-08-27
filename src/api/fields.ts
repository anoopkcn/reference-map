/** Lean field set for lists / graph expansion / search. No abstract, no bibtex. */
export const LIST_FIELDS = [
  'paperId',
  'title',
  'year',
  'authors',
  'venue',
  'journal',
  'citationCount',
  'referenceCount',
  'influentialCitationCount',
  'externalIds',
  'isOpenAccess',
  'openAccessPdf',
  'publicationTypes',
  'publicationDate',
] as const;

/** Full set for seeds / selected paper. */
export const DETAIL_FIELDS = [...LIST_FIELDS, 'abstract', 'citationStyles'] as const;

export const LIST_FIELDS_PARAM = LIST_FIELDS.join(',');
export const DETAIL_FIELDS_PARAM = DETAIL_FIELDS.join(',');

/** Hard limits of the Semantic Scholar Graph and Recommendations APIs. */
export const S2_LIMITS = { list: 1000, search: 100, batch: 500, recommendations: 500 } as const;
