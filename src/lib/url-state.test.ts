import { describe, expect, it } from 'vitest';
import { decodeUrlState, encodeUrlState } from './url-state';

describe('url-state', () => {
  it('round-trips lookups and selection', () => {
    const s = { lookups: ['DOI:10.18653/v1/N18-3011', 'ARXIV:1706.03762', 'URL:https://arxiv.org/abs/1?x=1,2'], sel: 'abc' };
    const qs = encodeUrlState(s);
    expect(qs).toBe('?ids=DOI:10.18653/v1/N18-3011,ARXIV:1706.03762,URL:https://arxiv.org/abs/1%3Fx%3D1%2C2&sel=abc');
    expect(decodeUrlState(qs)).toEqual(s);
  });
  it('empty state encodes to empty string', () => {
    expect(encodeUrlState({ lookups: [], sel: null })).toBe('');
    expect(decodeUrlState('')).toEqual({ lookups: [], sel: null });
    expect(decodeUrlState('?ids=&sel=')).toEqual({ lookups: [], sel: null });
  });
  it('tolerates stray whitespace and legacy encoding', () => {
    expect(decodeUrlState('?ids=DOI%3A10.1%2Fx,%20ARXIV:1')).toEqual({ lookups: ['DOI:10.1/x', 'ARXIV:1'], sel: null });
  });
});
