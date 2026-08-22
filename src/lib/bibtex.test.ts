import { describe, expect, it } from 'vitest';
import type { Paper } from '../types';
import { generateBibtex } from './bibtex';

const paper: Paper = {
  paperId: 'doi:10.1/x',
  sources: { openalex: 'W1' },
  title: 'Attention Is All You Need',
  year: 2017,
  authors: [
    { authorId: null, name: 'Ashish Vaswani' },
    { authorId: null, name: 'Noam Shazeer' },
  ],
  venue: 'Neural Information Processing Systems',
  journal: { volume: '30', pages: '5998-6008' },
  citationCount: 1,
  referenceCount: 1,
  influentialCitationCount: null,
  externalIds: { DOI: '10.1/X' },
  isOpenAccess: true,
  openAccessPdf: null,
  publicationTypes: ['Conference'],
  publicationDate: null,
  detailLevel: 'full',
  fetchedAt: 0,
};

describe('generateBibtex', () => {
  it('builds an inproceedings entry with a sensible key', () => {
    expect(generateBibtex(paper)).toBe(
      [
        '@inproceedings{vaswani2017attention,',
        '  title = {Attention Is All You Need},',
        '  author = {Ashish Vaswani and Noam Shazeer},',
        '  year = {2017},',
        '  booktitle = {Neural Information Processing Systems},',
        '  volume = {30},',
        '  pages = {5998--6008},',
        '  doi = {10.1/X},',
        '  url = {https://doi.org/10.1/X}',
        '}',
      ].join('\n'),
    );
  });
  it('falls back to article / misc and skips empty fields', () => {
    expect(generateBibtex({ ...paper, publicationTypes: [], journal: null })).toContain('@article{vaswani2017attention,');
    const misc = generateBibtex({ ...paper, publicationTypes: [], journal: null, venue: '', authors: [], year: null, externalIds: {} });
    expect(misc.startsWith('@misc{anonattention,')).toBe(true);
    expect(misc).not.toContain('author');
    expect(misc).not.toContain('url');
  });
});
