/**
 * Confluence-layout geometry: seeds become fixed anchors on a circle (similar seeds adjacent)
 * and every other paper is targeted at the weighted barycenter of the seeds its affinity vector
 * points to, pushed outward by how specific that vector is — so single-seed papers fan out
 * behind their anchor, bridges sit between anchors, and papers every seed touches gather at
 * the center. Shared by the bridge (worker targets) and the renderer (anchor guide circle),
 * so the guide passes exactly through the seed anchors.
 */

export interface Point {
  x: number;
  y: number;
}

/** Rounds of neighbour averaging; affinity stabilizes well before this at map sizes. */
const AFFINITY_ITERATIONS = 12;
/** Rows whose total weight stays below this are treated as unreached (no target). */
const AFFINITY_EPS = 1e-6;
/** Radial push: specificity h ∈ (1/k, 1] scales the barycenter by SPEC_BASE + SPEC_RANGE·h. */
const SPEC_BASE = 0.42;
const SPEC_RANGE = 0.94;

/** Anchor-circle radius: grows with seed count and (gently) with map size. 0 when < 2 seeds. */
export function anchorRadius(seedCount: number, nodeCount: number): number {
  if (seedCount < 2) return 0;
  return Math.max(160, 40 * seedCount, 13 * Math.sqrt(Math.max(0, nodeCount)));
}

/** Seed anchors on a circle around the world origin, first at 12 o'clock. 1 seed → origin. */
export function anchorPositions(seedCount: number, nodeCount: number): Point[] {
  if (seedCount <= 0) return [];
  if (seedCount === 1) return [{ x: 0, y: 0 }];
  const r = anchorRadius(seedCount, nodeCount);
  const out: Point[] = [];
  for (let j = 0; j < seedCount; j++) {
    const a = -Math.PI / 2 + (j * 2 * Math.PI) / seedCount;
    out.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return out;
}

/**
 * Per-node seed-affinity vectors (row-major n×k) by iterated neighbour averaging over the
 * undirected edge list: seeds stay clamped to their own identity, every other row becomes the
 * normalized sum of itself and its neighbours. Direct seed neighbours end up dominated by that
 * seed; second-ring nodes inherit their parents' mix; nodes with no path to a seed stay zero.
 * Deterministic, O(iterations × edges × seeds).
 */
export function computeAffinity(n: number, edgeSrc: ArrayLike<number>, edgeDst: ArrayLike<number>, m: number, seedIdx: readonly number[]): Float32Array {
  const k = seedIdx.length;
  const w = new Float32Array(n * k);
  if (k === 0 || n === 0) return w;
  const seedRow = new Int32Array(n).fill(-1);
  for (let j = 0; j < k; j++) {
    const idx = seedIdx[j]!;
    if (idx >= 0 && idx < n) seedRow[idx] = j;
  }
  for (let i = 0; i < n; i++) {
    const j = seedRow[i]!;
    if (j >= 0) w[i * k + j] = 1;
  }
  const next = new Float32Array(n * k);
  for (let it = 0; it < AFFINITY_ITERATIONS; it++) {
    next.set(w); // self term damps oscillation on bipartite-ish structures
    for (let e = 0; e < m; e++) {
      const a = edgeSrc[e]!;
      const b = edgeDst[e]!;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      for (let j = 0; j < k; j++) {
        next[a * k + j]! += w[b * k + j]!;
        next[b * k + j]! += w[a * k + j]!;
      }
    }
    for (let i = 0; i < n; i++) {
      const sj = seedRow[i]!;
      if (sj >= 0) {
        for (let j = 0; j < k; j++) next[i * k + j] = j === sj ? 1 : 0;
        continue;
      }
      let sum = 0;
      for (let j = 0; j < k; j++) sum += next[i * k + j]!;
      if (sum > 0) for (let j = 0; j < k; j++) next[i * k + j]! /= sum;
    }
    w.set(next);
  }
  return w;
}

/**
 * Fill tx/ty (length n) from affinity rows: seeds land exactly on their anchor; other nodes at
 * their affinity barycenter scaled by specificity (Herfindahl of the normalized row), so a
 * single-seed paper is pushed radially beyond its anchor while an evenly-shared one stays near
 * the center. Unreached rows get NaN (the sim falls back to gentle centering).
 */
export function affinityTargets(weights: Float32Array, seedIdx: readonly number[], anchors: readonly Point[], n: number, tx: Float32Array, ty: Float32Array): void {
  const k = seedIdx.length;
  const seedRow = new Map<number, number>();
  for (let j = 0; j < k; j++) seedRow.set(seedIdx[j]!, j);
  for (let i = 0; i < n; i++) {
    const sj = seedRow.get(i);
    if (sj !== undefined) {
      tx[i] = anchors[sj]!.x;
      ty[i] = anchors[sj]!.y;
      continue;
    }
    let sum = 0;
    for (let j = 0; j < k; j++) sum += weights[i * k + j]!;
    if (!(sum > AFFINITY_EPS)) {
      tx[i] = NaN;
      ty[i] = NaN;
      continue;
    }
    let bx = 0;
    let by = 0;
    let h = 0;
    for (let j = 0; j < k; j++) {
      const p = weights[i * k + j]! / sum;
      bx += p * anchors[j]!.x;
      by += p * anchors[j]!.y;
      h += p * p;
    }
    const push = SPEC_BASE + SPEC_RANGE * h;
    tx[i] = bx * push;
    ty[i] = by * push;
  }
}

/**
 * Order seeds so that pairs with overlapping reference lists sit on adjacent anchors (bridge
 * papers between adjacent anchors read correctly; a barycenter between non-adjacent anchors is
 * the layout's known ambiguity). Greedy chain on Jaccard similarity of the cached refs lists;
 * seeds without a cached list keep their relative input order.
 */
export function orderSeeds(seedIds: readonly string[], refsOf: (id: string) => readonly string[] | undefined): string[] {
  if (seedIds.length <= 2) return [...seedIds];
  const sets = seedIds.map((id) => new Set(refsOf(id) ?? []));
  const sim = (a: number, b: number): number => {
    const sa = sets[a]!;
    const sb = sets[b]!;
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    for (const id of small) if (large.has(id)) inter++;
    return inter / (sa.size + sb.size - inter);
  };
  // start from the most similar pair (index order breaks ties → deterministic)
  let bi = 0;
  let bj = 1;
  let best = -1;
  for (let i = 0; i < seedIds.length; i++) {
    for (let j = i + 1; j < seedIds.length; j++) {
      const s = sim(i, j);
      if (s > best) {
        best = s;
        bi = i;
        bj = j;
      }
    }
  }
  const chain = [bi, bj];
  const remaining = new Set<number>();
  for (let i = 0; i < seedIds.length; i++) if (i !== bi && i !== bj) remaining.add(i);
  while (remaining.size > 0) {
    const head = chain[0]!;
    const tail = chain[chain.length - 1]!;
    let pick = -1;
    let pickSim = -1;
    let atHead = false;
    for (const i of remaining) {
      const sh = sim(i, head);
      const st = sim(i, tail);
      const s = Math.max(sh, st);
      if (s > pickSim) {
        pickSim = s;
        pick = i;
        atHead = sh > st;
      }
    }
    remaining.delete(pick);
    if (atHead) chain.unshift(pick);
    else chain.push(pick);
  }
  return chain.map((i) => seedIds[i]!);
}
