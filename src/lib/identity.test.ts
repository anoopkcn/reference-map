import { describe, expect, it } from 'vitest';
import type { Paper } from '../types';
import { Identity, arxivFromDoi, keysOf, lookupToAliasKey, normDoi, type AliasEntry, type AliasStore } from './identity';

class MemStore implements AliasStore {
  m = new Map<string, AliasEntry>();
  batchWrites = 0;
  async getLookups(keys: readonly string[]) {
    const out = new Map<string, AliasEntry>();
    for (const k of keys) {
      const v = this.m.get(k);
      if (v) out.set(k, v);
    }
    return out;
  }
  async putLookup(key: string, v: AliasEntry) {
    this.m.set(key, v);
  }
  async putLookups(entries: readonly (readonly [string, AliasEntry])[]) {
    this.batchWrites++;
    for (const [key, v] of entries) this.m.set(key, v);
  }
}

const mk = (over: Partial<Paper>): Paper => ({
  paperId: 'tmp',
  sources: {},
  title: 't',
  year: null,
  authors: [],
  venue: '',
  journal: null,
  citationCount: 0,
  referenceCount: 0,
  influentialCitationCount: null,
  externalIds: {},
  isOpenAccess: false,
  openAccessPdf: null,
  publicationTypes: [],
  publicationDate: null,
  detailLevel: 'list',
  fetchedAt: 0,
  ...over,
});

describe('identity helpers', () => {
  it('normDoi / arxivFromDoi', () => {
    expect(normDoi('https://doi.org/10.18653/V1/N18-3011')).toBe('10.18653/v1/n18-3011');
    expect(normDoi('doi:10.1/X')).toBe('10.1/x');
    expect(arxivFromDoi('10.48550/arXiv.1706.03762v5')).toBe('1706.03762');
    expect(arxivFromDoi('10.1/x')).toBeNull();
  });
  it('keysOf: priority order, DataCite arXiv DOIs are aliases only', () => {
    expect(keysOf({ externalIds: { DOI: '10.1/X', ArXiv: '2106.15928v2', PubMed: '5', MAG: '9' }, sources: { s2: 'ABC', openalex: 'w1' } })).toEqual({
      canon: ['doi:10.1/x', 'arxiv:2106.15928', 'pmid:5', 'mag:9', 's2:abc', 'oa:W1'],
      extra: [],
    });
    expect(keysOf({ externalIds: { DOI: '10.48550/arXiv.1706.03762' }, sources: { openalex: 'W2' } })).toEqual({
      canon: ['arxiv:1706.03762', 'oa:W2'],
      extra: ['doi:10.48550/arxiv.1706.03762'],
    });
    expect(keysOf({ externalIds: { PubMedCentral: 'PMC12', CorpusId: '3', ACL: 'N18-3011' }, sources: {} })).toEqual({
      canon: [],
      extra: ['pmcid:12', 'corpusid:3', 'acl:n18-3011'],
    });
  });
  it('lookupToAliasKey', () => {
    const sha = 'f6c0e8b4b7c2c0f5c2f1a7a8b9d0e1f2a3b4c5d6';
    expect(lookupToAliasKey(sha.toUpperCase())).toBe(`s2:${sha}`);
    expect(lookupToAliasKey(`s2:${sha}`)).toBe(`s2:${sha}`);
    expect(lookupToAliasKey('DOI:10.1/X')).toBe('doi:10.1/x');
    expect(lookupToAliasKey('doi:10.48550/arXiv.1706.03762')).toBe('arxiv:1706.03762');
    expect(lookupToAliasKey('ARXIV:1706.03762v2')).toBe('arxiv:1706.03762');
    expect(lookupToAliasKey('oa:w123')).toBe('oa:W123');
    expect(lookupToAliasKey('openalex:W123')).toBe('oa:W123');
    expect(lookupToAliasKey('PMCID:PMC12')).toBe('pmcid:12');
    expect(lookupToAliasKey('CorpusId:3')).toBe('corpusid:3');
    expect(lookupToAliasKey('URL:https://Arxiv.org/abs/1')).toBe('url:https://arxiv.org/abs/1');
    expect(lookupToAliasKey('nonsense')).toBeNull();
  });
});

describe('Identity.assign', () => {
  it('persists every alias from a normalization batch with one store write', async () => {
    const store = new MemStore();
    const id = new Identity(store, () => 1);
    await id.assign([
      mk({ sources: { s2: 'a' }, externalIds: { DOI: '10.1/a', PubMed: '1' } }),
      mk({ sources: { openalex: 'W2' }, externalIds: { DOI: '10.1/b', MAG: '2' } }),
    ]);
    expect(store.batchWrites).toBe(1);
    expect(store.m.size).toBe(6);
  });
  it('mints by priority and merges across providers via shared keys', async () => {
    const store = new MemStore();
    const id = new Identity(store, () => 1);
    const a = mk({ paperId: 's2:abc', sources: { s2: 'abc' }, externalIds: { DOI: '10.1/X' } });
    await id.assign([a]);
    expect(a.paperId).toBe('doi:10.1/x');
    // the same paper from OpenAlex (DOI only) lands on the same canonical id
    const b = mk({ paperId: 'oa:W1', sources: { openalex: 'W1' }, externalIds: { DOI: 'https://doi.org/10.1/x' } });
    await id.assign([b]);
    expect(b.paperId).toBe('doi:10.1/x');
    expect(id.peek('oa:W1')?.paperId).toBe('doi:10.1/x');
    expect(id.stats).toEqual({ minted: 1, merged: 1, conflicts: 0 });
  });
  it('existing canonical id wins even if a higher-priority key appears later', async () => {
    const id = new Identity(new MemStore(), () => 1);
    const a = mk({ paperId: 's2:abc', sources: { s2: 'abc' } });
    await id.assign([a]);
    expect(a.paperId).toBe('s2:abc');
    const b = mk({ paperId: 's2:abc', sources: { s2: 'abc' }, externalIds: { DOI: '10.2/y' } });
    await id.assign([b]);
    expect(b.paperId).toBe('s2:abc');
    expect(id.peek('doi:10.2/y')?.paperId).toBe('s2:abc');
    const c = mk({ paperId: 'oa:W9', sources: { openalex: 'W9' }, externalIds: { DOI: '10.2/Y' } });
    await id.assign([c]);
    expect(c.paperId).toBe('s2:abc');
  });
  it('DataCite arXiv DOI unifies with an arXiv-only record; conflicts are counted, never re-keyed', async () => {
    const id = new Identity(new MemStore(), () => 1);
    const s2 = mk({ paperId: 's2:a', sources: { s2: 'a' }, externalIds: { ArXiv: '1706.03762' } });
    const oa = mk({ paperId: 'oa:W1', sources: { openalex: 'W1' }, externalIds: { DOI: '10.48550/arXiv.1706.03762' } });
    await id.assign([s2]);
    await id.assign([oa]);
    expect(s2.paperId).toBe('arxiv:1706.03762');
    expect(oa.paperId).toBe('arxiv:1706.03762');
    // two papers minted separately, later bridged by one record → conflict counted, ids unchanged
    const p1 = mk({ paperId: 'x', sources: { s2: 'p1' } });
    const p2 = mk({ paperId: 'y', sources: { openalex: 'W2' } });
    await id.assign([p1, p2]);
    const bridge = mk({ paperId: 'z', sources: { s2: 'p1', openalex: 'W2' } });
    await id.assign([bridge]);
    expect(bridge.paperId).toBe('s2:p1');
    expect(id.stats.conflicts).toBe(1);
  });
  it('passes through papers without ids; persists aliases to the store and reloads them', async () => {
    const store = new MemStore();
    const id = new Identity(store, () => 1);
    const mock = mk({ paperId: 'A' });
    await id.assign([mock]);
    expect(mock.paperId).toBe('A');
    await id.assign([mk({ paperId: 'tmp', sources: { s2: 'abc' }, externalIds: { DOI: '10.1/x' } })]);
    const fresh = new Identity(store, () => 2);
    expect(await fresh.resolve('doi:10.1/x')).toEqual({ paperId: 'doi:10.1/x', fetchedAt: 1 });
    const again = mk({ paperId: 'oa:W5', sources: { openalex: 'W5' }, externalIds: { DOI: '10.1/x' } });
    await fresh.assign([again]);
    expect(again.paperId).toBe('doi:10.1/x');
    fresh.negative('doi:10.9/none');
    expect((await fresh.resolve('doi:10.9/none'))?.paperId).toBeNull();
  });
});
