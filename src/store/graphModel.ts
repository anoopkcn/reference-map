import { nodeLabel } from '../lib/format';
import { NodeRole, type ListKind, type Paper, type PaperId } from '../types';

export const R_MIN = 2.5;
export const R_MAX = 14;

export interface GraphNode {
  id: PaperId;
  /** Stable index: position in `order`, used by the worker and renderer. Reset only by `rebuild`. */
  idx: number;
  role: NodeRole;
  r: number;
  seed: boolean;
  expanded: boolean;
  pinned: boolean;
  label: string;
  citationCount: number;
}

/** Changes since the last drain, consumed by the worker bridge. */
export interface GraphDiff {
  /** Structure was rebuilt from scratch; bridge must resend everything. */
  reset: boolean;
  /** idx of nodes added (in order). */
  newNodes: number[];
  /** idx of the node each new node was added from (-1 = none), aligned with newNodes. */
  parents: number[];
  /** Flat [src, dst, …] idx pairs of edges added. */
  newEdges: number[];
  radiiChanged: boolean;
}

const freshDiff = (): GraphDiff => ({ reset: false, newNodes: [], parents: [], newEdges: [], radiiChanged: false });

export type CachedListGetter = (id: PaperId, kind: ListKind) => readonly PaperId[] | undefined;

/**
 * Pure graph data structure. Edges are directed `citing → cited`.
 * All membership checks are O(1) (Map/Set); flat idx arrays are kept for the renderer.
 */
export class GraphModel {
  readonly nodes = new Map<PaperId, GraphNode>();
  /** idx → id. Append-only between rebuilds. */
  readonly order: PaperId[] = [];
  readonly edges = new Set<string>();
  /** citing → set of cited */
  readonly outgoing = new Map<PaperId, Set<PaperId>>();
  /** cited → set of citing */
  readonly incoming = new Map<PaperId, Set<PaperId>>();
  readonly edgeSrc: number[] = [];
  readonly edgeDst: number[] = [];
  readonly seeds = new Set<PaperId>();
  /** Ids in the order they were expanded (used to replay on rebuild). */
  readonly expandedOrder: PaperId[] = [];
  /** Bumped on every mutation. */
  version = 0;
  /** Largest citation count among current nodes (radius scale). */
  maxCitations = 0;
  private diff: GraphDiff = freshDiff();

  get nodeCount(): number {
    return this.order.length;
  }
  get edgeCount(): number {
    return this.edgeSrc.length;
  }
  hasNode(id: PaperId): boolean {
    return this.nodes.has(id);
  }
  getNode(id: PaperId): GraphNode | undefined {
    return this.nodes.get(id);
  }
  idAt(idx: number): PaperId | undefined {
    return this.order[idx];
  }

  /** Add (or mark) a seed node. */
  addSeed(id: PaperId, paper: Paper, papers: ReadonlyMap<PaperId, Paper>): GraphNode {
    const existed = this.nodes.has(id);
    this.addNode(id, paper, -1);
    this.seeds.add(id);
    const n = this.nodes.get(id)!;
    n.seed = true;
    if (existed) this.version++;
    this.recompute(papers);
    return n;
  }

  /** Returns true if the node was newly added. */
  addNode(id: PaperId, paper: Paper, parentIdx = -1): boolean {
    if (this.nodes.has(id)) return false;
    const idx = this.order.length;
    const node: GraphNode = {
      id,
      idx,
      role: NodeRole.Isolated,
      r: R_MIN,
      seed: false,
      expanded: false,
      pinned: false,
      label: nodeLabel(paper),
      citationCount: paper.citationCount,
    };
    this.nodes.set(id, node);
    this.order.push(id);
    this.diff.newNodes.push(idx);
    this.diff.parents.push(parentIdx);
    this.version++;
    return true;
  }

  /** Returns true if the edge was newly added. Both endpoints must exist. */
  addEdge(citing: PaperId, cited: PaperId): boolean {
    if (citing === cited) return false;
    const a = this.nodes.get(citing);
    const b = this.nodes.get(cited);
    if (!a || !b) return false;
    const key = `${citing}>${cited}`;
    if (this.edges.has(key)) return false;
    this.edges.add(key);
    let out = this.outgoing.get(citing);
    if (!out) this.outgoing.set(citing, (out = new Set()));
    out.add(cited);
    let inc = this.incoming.get(cited);
    if (!inc) this.incoming.set(cited, (inc = new Set()));
    inc.add(citing);
    this.edgeSrc.push(a.idx);
    this.edgeDst.push(b.idx);
    this.diff.newEdges.push(a.idx, b.idx);
    this.version++;
    return true;
  }

  /**
   * Merge the neighbourhood of `center`: connect to nodes already present (edge discovery),
   * then add up to `limit` new nodes per direction (highest citation count first).
   */
  mergeNeighborhood(
    center: PaperId,
    refIds: readonly PaperId[] | null | undefined,
    citeIds: readonly PaperId[] | null | undefined,
    papers: ReadonlyMap<PaperId, Paper>,
    limit: number,
    getCachedList?: CachedListGetter,
  ): { added: number } {
    const c = this.nodes.get(center);
    if (!c) return { added: 0 };
    if (!c.expanded) {
      c.expanded = true;
      this.expandedOrder.push(center);
      this.version++;
    }
    const newIds: PaperId[] = [];
    const process = (ids: readonly PaperId[] | null | undefined, kind: ListKind) => {
      if (!ids) return;
      const fresh: PaperId[] = [];
      for (const id of ids) {
        if (id === center) continue;
        if (this.nodes.has(id)) {
          if (kind === 'refs') this.addEdge(center, id);
          else this.addEdge(id, center);
        } else {
          fresh.push(id);
        }
      }
      if (fresh.length > limit) {
        const cc = (id: PaperId) => papers.get(id)?.citationCount ?? 0;
        fresh.sort((x, y) => cc(y) - cc(x));
      }
      for (const id of fresh.slice(0, limit)) {
        const p = papers.get(id);
        if (!p) continue;
        if (this.addNode(id, p, c.idx)) newIds.push(id);
        if (kind === 'refs') this.addEdge(center, id);
        else this.addEdge(id, center);
      }
    };
    process(refIds, 'refs');
    process(citeIds, 'cites');

    // Free extra discovery: new nodes whose lists are already cached connect to existing nodes only.
    if (getCachedList) {
      for (const id of newIds) {
        const r = getCachedList(id, 'refs');
        if (r) for (const t of r) if (this.nodes.has(t)) this.addEdge(id, t);
        const ci = getCachedList(id, 'cites');
        if (ci) for (const s of ci) if (this.nodes.has(s)) this.addEdge(s, id);
      }
    }
    this.recompute(papers);
    return { added: newIds.length };
  }

  setPinned(id: PaperId, pinned: boolean): void {
    const n = this.nodes.get(id);
    if (n && n.pinned !== pinned) {
      n.pinned = pinned;
      this.version++;
    }
  }

  unpinAll(): void {
    for (const n of this.nodes.values()) n.pinned = false;
    this.version++;
  }

  /** Recompute roles and radii for all nodes (O(n)). */
  recompute(papers: ReadonlyMap<PaperId, Paper>): void {
    let maxC = 1;
    for (const n of this.nodes.values()) {
      const c = papers.get(n.id)?.citationCount ?? n.citationCount;
      n.citationCount = c;
      if (c > maxC) maxC = c;
    }
    this.maxCitations = maxC;
    const denom = Math.log1p(maxC);
    for (const n of this.nodes.values()) {
      n.seed = this.seeds.has(n.id);
      const hasIn = (this.incoming.get(n.id)?.size ?? 0) > 0;
      const hasOut = (this.outgoing.get(n.id)?.size ?? 0) > 0;
      n.role = n.seed ? NodeRole.Seed : hasIn && hasOut ? NodeRole.Both : hasIn ? NodeRole.Cited : hasOut ? NodeRole.Citing : NodeRole.Isolated;
      n.r = R_MIN + (R_MAX - R_MIN) * (denom > 0 ? Math.log1p(n.citationCount) / denom : 0);
    }
    this.diff.radiiChanged = true;
    this.version++;
  }

  /**
   * Rebuild from the given seeds, replaying the neighbourhoods of seeds that were expanded
   * (from cached lists). Expansions of papers that are no longer seeds are dropped — including the
   * edges discovered through them — and nodes no longer reachable disappear; indices are reassigned.
   */
  rebuild(seeds: readonly PaperId[], papers: ReadonlyMap<PaperId, Paper>, limit: number, getCachedList: CachedListGetter): void {
    const seedSet = new Set(seeds);
    const previouslyExpanded = this.expandedOrder.filter((id) => seedSet.has(id));
    const pinned = new Set<PaperId>();
    for (const n of this.nodes.values()) if (n.pinned) pinned.add(n.id);
    this.clearInternal();
    for (const id of seeds) {
      const p = papers.get(id);
      if (p) {
        this.addNode(id, p, -1);
        this.seeds.add(id);
      }
    }
    // Replay until stable (an expanded node may only become reachable after another is replayed).
    const done = new Set<PaperId>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of previouslyExpanded) {
        if (done.has(id) || !this.nodes.has(id)) continue;
        done.add(id);
        progressed = true;
        // No cached-list discovery here: edges come only from the seeds' own lists, so removing a seed
        // also removes every connection that was discovered through it.
        this.mergeNeighborhood(id, getCachedList(id, 'refs'), getCachedList(id, 'cites'), papers, limit);
      }
    }
    for (const id of pinned) {
      const n = this.nodes.get(id);
      if (n) n.pinned = true;
    }
    this.recompute(papers);
    this.diff = { ...freshDiff(), reset: true, radiiChanged: true };
    this.version++;
  }

  clear(): void {
    this.clearInternal();
    this.diff = { ...freshDiff(), reset: true };
    this.version++;
  }

  private clearInternal(): void {
    this.nodes.clear();
    this.order.length = 0;
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.edgeSrc.length = 0;
    this.edgeDst.length = 0;
    this.seeds.clear();
    this.expandedOrder.length = 0;
    this.maxCitations = 0;
    this.diff = freshDiff();
  }

  /** Return and reset accumulated changes. */
  drainDiff(): GraphDiff {
    const d = this.diff;
    this.diff = freshDiff();
    return d;
  }

  /** Neighbour ids (both directions). */
  neighbors(id: PaperId): Set<PaperId> {
    const out = new Set<PaperId>();
    this.outgoing.get(id)?.forEach((x) => out.add(x));
    this.incoming.get(id)?.forEach((x) => out.add(x));
    return out;
  }
}
