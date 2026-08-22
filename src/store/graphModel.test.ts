import { describe, expect, it } from 'vitest';
import { NodeRole, type Paper } from '../types';
import { GraphModel, R_MAX, R_MIN } from './graphModel';

const mk = (id: string, citationCount = 0, over: Partial<Paper> = {}): Paper => ({
  paperId: id,
  title: `Paper ${id}`,
  year: 2020,
  authors: [{ authorId: null, name: `Auth ${id}` }],
  venue: '',
  journal: null,
  citationCount,
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

const papers = new Map<string, Paper>();
for (const [id, c] of [['S', 1000], ['A', 10], ['B', 500], ['C', 5], ['D', 50], ['E', 0], ['F', 7], ['T', 100]] as const) papers.set(id, mk(id, c));

describe('GraphModel', () => {
  it('adds a seed and merges a neighbourhood with roles/radii', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    expect(g.nodeCount).toBe(1);
    expect(g.getNode('S')!.role).toBe(NodeRole.Seed);

    g.mergeNeighborhood('S', ['A', 'B'], ['C', 'D'], papers, 100);
    expect(g.nodeCount).toBe(5);
    expect(g.edgeCount).toBe(4);
    expect(g.edges.has('S>A')).toBe(true);
    expect(g.edges.has('C>S')).toBe(true);
    expect(g.getNode('A')!.role).toBe(NodeRole.Cited);
    expect(g.getNode('C')!.role).toBe(NodeRole.Citing);
    expect(g.getNode('S')!.expanded).toBe(true);
    expect(g.getNode("S")!.r).toBeCloseTo(R_MAX);
    expect(g.getNode('A')!.r).toBeGreaterThan(R_MIN);
    expect(g.getNode('A')!.r).toBeLessThan(R_MAX);
  });

  it('discovers edges among existing nodes when expanding, dedupes edges, marks Both', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    g.mergeNeighborhood('S', ['A', 'B'], ['C'], papers, 100);
    g.drainDiff();
    // Expanding A: A cites B (already present) and is cited by C (present) and by new node D.
    const r = g.mergeNeighborhood('A', ['B', 'S'], ['C', 'D'], papers, 100);
    expect(r.added).toBe(1);
    expect(g.edges.has('A>B')).toBe(true);
    expect(g.edges.has('A>S')).toBe(true);
    expect(g.edges.has('C>A')).toBe(true);
    expect(g.edges.has('D>A')).toBe(true);
    expect(g.getNode('A')!.role).toBe(NodeRole.Both);
    expect(g.getNode('S')!.role).toBe(NodeRole.Seed);
    // re-merge the same lists: nothing new
    const before = g.edgeCount;
    g.mergeNeighborhood('A', ['B', 'S'], ['C', 'D'], papers, 100);
    expect(g.edgeCount).toBe(before);
    const d = g.drainDiff();
    expect(d.newNodes).toEqual([g.getNode('D')!.idx]);
    expect(d.parents).toEqual([g.getNode('A')!.idx]);
    expect(d.newEdges.length).toBe(2 * 4);
    expect(g.drainDiff().newEdges).toEqual([]);
  });

  it('caps new nodes per direction by citation count', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    g.mergeNeighborhood('S', ['A', 'B', 'C', 'D'], ['E', 'F'], papers, 2);
    expect([...g.nodes.keys()].sort()).toEqual(['B', 'D', 'E', 'F', 'S']);
    // later expansion of another node referencing A connects nothing new to A (A not present) …
    g.mergeNeighborhood('B', ['A'], [], papers, 2);
    expect(g.hasNode('A')).toBe(true); // … but adds it under B
    expect(g.edges.has('B>A')).toBe(true);
  });

  it('uses cached lists of new nodes for extra edges to existing nodes only', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    const cached = new Map<string, string[]>([['A:refs', ['B', 'T']], ['A:cites', ['C']]]);
    g.mergeNeighborhood('S', ['A', 'B'], ['C'], papers, 100, (id, k) => cached.get(`${id}:${k}`));
    expect(g.edges.has('A>B')).toBe(true);
    expect(g.edges.has('C>A')).toBe(true);
    expect(g.hasNode('T')).toBe(false);
  });

  it('rebuild drops unreachable nodes, keeps shared ones, reassigns indices, keeps pins', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    g.addSeed('T', papers.get('T')!, papers);
    const lists = new Map<string, string[]>([
      ['S:refs', ['A', 'B']],
      ['S:cites', []],
      ['T:refs', ['B', 'C']],
      ['T:cites', ['D']],
      ['A:refs', ['E']],
      ['A:cites', []],
    ]);
    const get = (id: string, k: string) => lists.get(`${id}:${k}`);
    g.mergeNeighborhood('S', get('S', 'refs'), get('S', 'cites'), papers, 100);
    g.mergeNeighborhood('T', get('T', 'refs'), get('T', 'cites'), papers, 100);
    g.mergeNeighborhood('A', get('A', 'refs'), get('A', 'cites'), papers, 100);
    g.setPinned('B', true);
    expect(g.nodeCount).toBe(7);
    // remove seed S: A (expanded but not a seed) is no longer replayed, even though it stays reachable via T? (it is not)
    g.rebuild(['T'], papers, 100, get);
    expect([...g.nodes.keys()].sort()).toEqual(['B', 'C', 'D', 'T']);
    // a non-seed expansion is dropped on rebuild even when the node survives
    g.addSeed('S', papers.get('S')!, papers);
    g.mergeNeighborhood('S', get('S', 'refs'), get('S', 'cites'), papers, 100);
    g.mergeNeighborhood('A', get('A', 'refs'), get('A', 'cites'), papers, 100);
    expect(g.hasNode('E')).toBe(true);
    g.rebuild(['T', 'S'], papers, 100, get);
    expect(g.hasNode('A')).toBe(true);
    expect(g.hasNode('E')).toBe(false);
    expect(g.getNode('A')!.expanded).toBe(false);
    g.rebuild(['T'], papers, 100, get);
    expect(g.getNode('T')!.idx).toBe(0);
    expect(g.order.length).toBe(4);
    expect(g.getNode('B')!.pinned).toBe(true);
    expect(g.edges.has('T>B')).toBe(true);
    expect(g.edges.has('S>B')).toBe(false);
    const d = g.drainDiff();
    expect(d.reset).toBe(true);
    // remove last seed → empty
    g.rebuild([], papers, 100, get);
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
  });

  it('adding an existing node as a seed re-roles it', () => {
    const g = new GraphModel();
    g.addSeed('S', papers.get('S')!, papers);
    g.mergeNeighborhood('S', ['A'], [], papers, 100);
    expect(g.getNode('A')!.role).toBe(NodeRole.Cited);
    g.addSeed('A', papers.get('A')!, papers);
    expect(g.getNode('A')!.role).toBe(NodeRole.Seed);
    expect(g.nodeCount).toBe(2);
    expect(g.neighbors('A')).toEqual(new Set(['S']));
  });
});
