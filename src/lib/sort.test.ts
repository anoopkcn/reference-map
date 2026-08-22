import { describe, expect, it } from 'vitest';
import type { Paper } from '../types';
import { filterIds, sortIds } from './sort';

const mk = (id: string, over: Partial<Paper>): Paper => ({
  paperId: id,
  sources: {},
  title: id,
  year: null,
  authors: [],
  venue: '',
  journal: null,
  citationCount: 0,
  referenceCount: 0,
  influentialCitationCount: 0,
  externalIds: {},
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: [],
  publicationDate: null,
  detailLevel: 'list',
  fetchedAt: 0,
  ...over,
});

const papers = new Map<string, Paper>([
  ['a', mk('a', { year: 2020, citationCount: 5, title: 'Deep learning', authors: [{ authorId: null, name: 'Yann LeCun' }] })],
  ['b', mk('b', { year: 2018, citationCount: 50, title: 'Graph networks', venue: 'ICLR' })],
  ['c', mk('c', { year: null, citationCount: 50, title: 'Old paper', externalIds: { DOI: '10.1/xyz' } })],
  ['d', mk('d', { year: 2021, citationCount: 1, journal: { name: 'Nature' } })],
]);

describe('sortIds', () => {
  const ids = ['a', 'b', 'c', 'd', 'zz'];
  it('desc puts nulls/unknown last and is stable on ties', () => {
    expect(sortIds(ids, papers, 'citationCount', 'desc')).toEqual(['b', 'c', 'a', 'd', 'zz']);
    expect(sortIds(ids, papers, 'year', 'desc')).toEqual(['d', 'a', 'b', 'c', 'zz']);
  });
  it('asc also keeps nulls last', () => {
    expect(sortIds(ids, papers, 'year', 'asc')).toEqual(['b', 'a', 'd', 'c', 'zz']);
  });
  it('does not mutate input', () => {
    const input = ['d', 'a'];
    sortIds(input, papers, 'year', 'asc');
    expect(input).toEqual(['d', 'a']);
  });
});

describe('filterIds', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('matches title, author, venue, journal, year, doi; all terms must match', () => {
    expect(filterIds(ids, papers, '')).toEqual(ids);
    expect(filterIds(ids, papers, 'lecun')).toEqual(['a']);
    expect(filterIds(ids, papers, 'iclr')).toEqual(['b']);
    expect(filterIds(ids, papers, 'nature')).toEqual(['d']);
    expect(filterIds(ids, papers, '2020')).toEqual(['a']);
    expect(filterIds(ids, papers, '10.1/xyz')).toEqual(['c']);
    expect(filterIds(ids, papers, 'deep 2020')).toEqual(['a']);
    expect(filterIds(ids, papers, 'deep 2018')).toEqual([]);
  });
});
