import { describe, expect, it } from 'vitest';
import type { Paper } from '../types';
import { authorUrl, authorsLine, formatCount, nodeLabel, paperUrl, paperUrlLabel, plainCitation, pubTypeLabel, truncate, venueLine } from './format';

const paper = (over: Partial<Paper> = {}): Paper => ({
  paperId: 's2:abc',
  sources: { s2: 'abc' },
  title: 'Attention Is All You Need',
  year: 2017,
  authors: [
    { authorId: '1', name: 'Ashish Vaswani' },
    { authorId: '2', name: 'Noam Shazeer' },
  ],
  venue: 'NeurIPS',
  journal: null,
  citationCount: 100000,
  referenceCount: 40,
  influentialCitationCount: 9000,
  externalIds: { DOI: '10.1/x', ArXiv: '1706.03762' },
  isOpenAccess: true,
  openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762' },
  publicationTypes: ['JournalArticle'],
  publicationDate: '2017-06-12',
  detailLevel: 'list',
  fetchedAt: 0,
  ...over,
});

describe('format', () => {
  it('authorsLine', () => {
    expect(authorsLine([])).toBe('');
    expect(authorsLine(paper().authors)).toBe('Ashish Vaswani, Noam Shazeer');
    expect(authorsLine(paper().authors, 1)).toBe('Ashish Vaswani et al.');
  });
  it('nodeLabel', () => {
    expect(nodeLabel(paper())).toBe('Vaswani et al. 2017');
    expect(nodeLabel(paper({ authors: [{ authorId: null, name: 'Solo Author' }], year: null }))).toBe('Author');
    expect(nodeLabel(paper({ authors: [], year: 2020 }))).toBe('Attention Is All You Need 2020');
  });
  it('venueLine prefers journal and omits missing parts', () => {
    expect(venueLine(paper())).toBe('NeurIPS');
    expect(venueLine(paper({ journal: { name: 'Nature', volume: '1', pages: '2-3' } }))).toBe('Nature, 1, 2-3');
    expect(venueLine(paper({ journal: { name: '', pages: '2-3' } }))).toBe('NeurIPS, 2-3');
    expect(venueLine(paper({ journal: null, venue: '' }))).toBe('');
    expect(venueLine(paper({ journal: { pages: '1-2' }, venue: '' }))).toBe('');
  });
  it('plainCitation', () => {
    expect(plainCitation(paper())).toBe(
      'Ashish Vaswani, Noam Shazeer (2017). Attention Is All You Need. NeurIPS. https://doi.org/10.1/x',
    );
    expect(plainCitation(paper({ externalIds: {}, venue: '', year: null }))).toBe(
      'Ashish Vaswani, Noam Shazeer. Attention Is All You Need. https://www.semanticscholar.org/paper/abc',
    );
  });
  it('paperUrl prefers provider pages, then DOI/arXiv fallbacks', () => {
    expect(paperUrl(paper())).toBe('https://www.semanticscholar.org/paper/abc');
    expect(paperUrlLabel(paper())).toBe('Open on Semantic Scholar');
    expect(paperUrl(paper({ externalIds: {} }))).toBe('https://www.semanticscholar.org/paper/abc');
    expect(paperUrl(paper({ sources: { openalex: 'W1' } }))).toBe('https://openalex.org/W1');
    expect(paperUrlLabel(paper({ sources: { openalex: 'W1' } }))).toBe('Open on OpenAlex');
    expect(paperUrl(paper({ sources: {}, externalIds: { DOI: '10.1/x', ArXiv: '1706.03762' } }))).toBe('https://doi.org/10.1/x');
    expect(paperUrlLabel(paper({ sources: {}, externalIds: { DOI: '10.1/x' } }))).toBe('Open via DOI');
    expect(paperUrl(paper({ externalIds: { ArXiv: '1706.03762' }, sources: {} }))).toBe('https://arxiv.org/abs/1706.03762');
    expect(paperUrlLabel(paper({ externalIds: { ArXiv: '1706.03762' }, sources: {} }))).toBe('Open on arXiv');
    expect(paperUrl(paper({ externalIds: {}, sources: {} }))).toBeNull();
    expect(paperUrlLabel(paper({ externalIds: {}, sources: {} }))).toBe('');
  });
  it('authorUrl selects the author provider', () => {
    expect(authorUrl({ authorId: '1', name: 'x' })).toBe('https://www.semanticscholar.org/author/1');
    expect(authorUrl({ authorId: 'A1', name: 'x', provider: 'openalex' })).toBe('https://openalex.org/A1');
    expect(authorUrl({ authorId: null, name: 'x' })).toBeNull();
  });
  it('truncate / formatCount / pubTypeLabel', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(12345)).toBe('12k');
    expect(formatCount(1_234_567)).toBe('1.2M');
    expect(pubTypeLabel('JournalArticle')).toBe('Journal Article');
  });
});
