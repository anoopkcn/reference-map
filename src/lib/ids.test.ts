import { describe, expect, it } from 'vitest';
import { displayLookup, normalizeLookup, parseInput, stripTrailingPunctuation } from './ids';

const SHA = 'f6c0e8b4b7c2c0f5c2f1a7a8b9d0e1f2a3b4c5d6';

describe('normalizeLookup', () => {
  const cases: [string, string | null][] = [
    // sha
    [SHA, SHA],
    [SHA.toUpperCase(), SHA],
    // bare DOIs
    ['10.18653/v1/N18-3011', 'DOI:10.18653/v1/N18-3011'],
    ['doi:10.18653/v1/N18-3011', 'DOI:10.18653/v1/N18-3011'],
    ['DOI: 10.18653/v1/N18-3011', 'DOI:10.18653/v1/N18-3011'],
    ['https://doi.org/10.18653/v1/N18-3011', 'DOI:10.18653/v1/N18-3011'],
    ['http://dx.doi.org/10.1000/182', 'DOI:10.1000/182'],
    ['doi.org/10.1000/182', 'DOI:10.1000/182'],
    ['see 10.1000/182.', 'DOI:10.1000/182'],
    ['(10.1000/182)', 'DOI:10.1000/182'],
    ['[10.1000/182]', 'DOI:10.1000/182'],
    ['10.1016/S0140-6736(20)30183-5', 'DOI:10.1016/S0140-6736(20)30183-5'],
    ['DOI:https://doi.org/10.1000/182', 'DOI:10.1000/182'],
    ['https://doi.org/10.1002/(SICI)1097-4571(199807)49:9%3C809::AID-ASI5%3E3.0.CO;2-A', 'DOI:10.1002/(SICI)1097-4571(199807)49:9<809::AID-ASI5>3.0.CO;2-A'],
    // DataCite arXiv DOIs → arXiv lookups (S2 doesn't index the DOI form)
    ['10.48550/arXiv.2409.05929', 'ARXIV:2409.05929'],
    ['DOI:10.48550/arXiv.2409.05929', 'ARXIV:2409.05929'],
    ['https://doi.org/10.48550/arXiv.2409.05929', 'ARXIV:2409.05929'],
    // arXiv
    ['2106.15928', 'ARXIV:2106.15928'],
    ['2106.15928v2', 'ARXIV:2106.15928'],
    ['1706.03762', 'ARXIV:1706.03762'],
    ['arXiv:1706.03762', 'ARXIV:1706.03762'],
    ['ARXIV: 1706.03762v5', 'ARXIV:1706.03762'],
    ['hep-th/9711200', 'ARXIV:hep-th/9711200'],
    ['math.GT/0309136v1', 'ARXIV:math.GT/0309136'],
    ['https://arxiv.org/abs/1706.03762', 'ARXIV:1706.03762'],
    ['https://arxiv.org/abs/1706.03762v5', 'ARXIV:1706.03762'],
    ['https://arxiv.org/pdf/1706.03762.pdf', 'ARXIV:1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v2', 'ARXIV:1706.03762'],
    ['http://export.arxiv.org/abs/hep-th/9711200', 'ARXIV:hep-th/9711200'],
    ['arxiv.org/abs/2106.15928', 'ARXIV:2106.15928'],
    // Semantic Scholar
    [`https://www.semanticscholar.org/paper/Attention-is-All-you-Need-Vaswani-Shazeer/${SHA}`, SHA],
    [`https://www.semanticscholar.org/paper/${SHA}`, SHA],
    [`https://www.semanticscholar.org/paper/${SHA}?utm=1`, SHA],
    ['https://www.semanticscholar.org/arxiv/1706.03762', 'ARXIV:1706.03762'],
    ['https://www.semanticscholar.org/author/123', 'URL:https://www.semanticscholar.org/author/123'],
    // other hosts
    ['https://dl.acm.org/doi/10.1145/3292500.3330701', 'DOI:10.1145/3292500.3330701'],
    ['https://dl.acm.org/doi/abs/10.1145/3292500.3330701', 'DOI:10.1145/3292500.3330701'],
    ['https://www.biorxiv.org/content/10.1101/2020.03.02.972935v1', 'DOI:10.1101/2020.03.02.972935'],
    ['https://www.biorxiv.org/content/10.1101/2020.03.02.972935v1.full.pdf', 'DOI:10.1101/2020.03.02.972935'],
    ['https://www.medrxiv.org/content/10.1101/2020.03.02.20030189v2', 'DOI:10.1101/2020.03.02.20030189'],
    ['https://pubmed.ncbi.nlm.nih.gov/19872477/', 'PMID:19872477'],
    ['https://www.ncbi.nlm.nih.gov/pmc/articles/PMC2323736/', 'PMCID:2323736'],
    ['https://pmc.ncbi.nlm.nih.gov/articles/PMC2323736/', 'PMCID:2323736'],
    ['https://aclanthology.org/N18-3011/', 'ACL:N18-3011'],
    ['https://aclanthology.org/2020.acl-main.1.pdf', 'ACL:2020.acl-main.1'],
    ['https://www.aclweb.org/anthology/N18-3011', 'ACL:N18-3011'],
    ['https://link.springer.com/article/10.1007/s11192-019-03222-9', 'DOI:10.1007/s11192-019-03222-9'],
    ['https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0123456', 'DOI:10.1371/journal.pone.0123456'],
    ['URL:https://arxiv.org/abs/2003.05991', 'ARXIV:2003.05991'],
    ['URL: https://www.biorxiv.org/about', 'URL:https://www.biorxiv.org/about'],
    // provider-native / canonical ids
    [`s2:${SHA}`, `s2:${SHA}`],
    [`S2:${SHA.toUpperCase()}`, `s2:${SHA}`],
    ['oa:W2801930304', 'oa:W2801930304'],
    ['openalex:w2801930304', 'oa:W2801930304'],
    ['W2801930304', 'oa:W2801930304'],
    ['https://openalex.org/W2801930304', 'oa:W2801930304'],
    ['https://openalex.org/works/W2801930304', 'oa:W2801930304'],
    ['https://api.openalex.org/works/W2801930304?select=id', 'oa:W2801930304'],
    ['doi:10.18653/v1/n18-3011', 'DOI:10.18653/v1/n18-3011'],
    ['arxiv:1706.03762', 'ARXIV:1706.03762'],
    // prefixed ids
    ['CorpusId:215416146', 'CorpusId:215416146'],
    ['corpusid: 215416146', 'CorpusId:215416146'],
    ['PMID:19872477', 'PMID:19872477'],
    ['PMCID:2323736', 'PMCID:2323736'],
    ['PMCID:PMC2323736', 'PMCID:2323736'],
    ['MAG:112218234', 'MAG:112218234'],
    ['ACL:N18-3011', 'ACL:N18-3011'],
    ['acl:2020.acl-main.1', 'ACL:2020.acl-main.1'],
    // not ids
    ['attention is all you need', null],
    ['https://www.nature.com/articles/s41586-020-2649-2', null],
    ['hello', null],
    ['', null],
    ['CorpusId:abc', null],
    ['DOI:nope', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeLookup(input)).toBe(expected);
    });
  }
});

describe('stripTrailingPunctuation', () => {
  it('keeps balanced parens and strips unbalanced ones', () => {
    expect(stripTrailingPunctuation('10.1016/S0140-6736(20)30183-5')).toBe('10.1016/S0140-6736(20)30183-5');
    expect(stripTrailingPunctuation('10.1000/182)')).toBe('10.1000/182');
    expect(stripTrailingPunctuation('10.1000/182).')).toBe('10.1000/182');
    expect(stripTrailingPunctuation('10.1000/18(2)).')).toBe('10.1000/18(2)');
  });
});

describe('parseInput', () => {
  it('empty', () => {
    expect(parseInput('   ')).toEqual({ kind: 'empty' });
  });
  it('single id', () => {
    expect(parseInput(' 10.18653/v1/N18-3011 ')).toEqual({ kind: 'ids', lookups: ['DOI:10.18653/v1/N18-3011'], rejected: [] });
  });
  it('prefixed id with space', () => {
    expect(parseInput('DOI: 10.18653/v1/N18-3011')).toEqual({ kind: 'ids', lookups: ['DOI:10.18653/v1/N18-3011'], rejected: [] });
  });
  it('multiple ids on lines / commas / spaces', () => {
    const r = parseInput('10.18653/v1/N18-3011\nARXIV:1706.03762, https://arxiv.org/abs/2106.15928 CorpusId:1');
    expect(r).toEqual({
      kind: 'ids',
      lookups: ['DOI:10.18653/v1/N18-3011', 'ARXIV:1706.03762', 'ARXIV:2106.15928', 'CorpusId:1'],
      rejected: [],
    });
  });
  it('dedupes case-insensitively', () => {
    const r = parseInput('arxiv:1706.03762 ARXIV:1706.03762');
    expect(r).toEqual({ kind: 'ids', lookups: ['ARXIV:1706.03762'], rejected: [] });
  });
  it('collects rejected lines when some parse', () => {
    const r = parseInput('10.1000/182\nnot an id here');
    expect(r).toEqual({ kind: 'ids', lookups: ['DOI:10.1000/182'], rejected: ['not an id here'] });
  });
  it('falls back to search', () => {
    expect(parseInput('attention   is all you need')).toEqual({ kind: 'search', query: 'attention is all you need' });
  });
  it('a sentence with a DOI inside is an id', () => {
    expect(parseInput('Check out https://doi.org/10.1000/182 please')).toEqual({ kind: 'ids', lookups: ['DOI:10.1000/182'], rejected: [] });
  });
});

describe('displayLookup', () => {
  it('formats', () => {
    expect(displayLookup('DOI:10.1000/182')).toBe('10.1000/182');
    expect(displayLookup('ARXIV:1706.03762')).toBe('arXiv:1706.03762');
    expect(displayLookup('URL:https://www.biorxiv.org/about')).toBe('biorxiv.org/about');
    expect(displayLookup(SHA)).toBe(SHA.slice(0, 10) + '…');
    expect(displayLookup(`s2:${SHA}`)).toBe(SHA.slice(0, 10) + '…');
    expect(displayLookup('oa:W123')).toBe('W123');
    expect(displayLookup('doi:10.1/x')).toBe('10.1/x');
    expect(displayLookup('PMID:1')).toBe('PMID:1');
  });
});
