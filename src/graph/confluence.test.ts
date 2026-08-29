import { describe, expect, it } from 'vitest';
import { affinityTargets, anchorPositions, anchorRadius, computeAffinity, orderSeeds } from './confluence';

const row = (w: Float32Array, k: number, i: number): number[] => Array.from(w.subarray(i * k, (i + 1) * k));

describe('computeAffinity', () => {
  it('gives a chain hanging off one seed full weight on that seed', () => {
    // 0(seed) — 1 — 2
    const w = computeAffinity(3, [0, 1], [1, 2], 2, [0]);
    expect(row(w, 1, 1)[0]).toBeCloseTo(1, 5);
    expect(row(w, 1, 2)[0]).toBeCloseTo(1, 5);
  });

  it('splits a direct bridge evenly between two seeds, and the second ring inherits the mix', () => {
    // seeds 0 and 2; node 1 links to both; node 3 links only to 1
    const w = computeAffinity(4, [0, 1, 1], [1, 2, 3], 3, [0, 2]);
    const bridge = row(w, 2, 1);
    expect(bridge[0]).toBeCloseTo(0.5, 3);
    expect(bridge[1]).toBeCloseTo(0.5, 3);
    const second = row(w, 2, 3);
    expect(second[0]).toBeCloseTo(0.5, 3);
    expect(second[1]).toBeCloseTo(0.5, 3);
  });

  it('leans toward the seed with more connecting edges', () => {
    // node 2 has two edges to seed 0 territory (via 0 twice is deduped in the graph, so use a helper node)
    // 0(seed) — 1 — 2 and 3(seed) — 2: node 2 sees seed 3 directly and seed 0 diluted through 1
    const w = computeAffinity(4, [0, 1, 3], [1, 2, 2], 3, [0, 3]);
    const r2 = row(w, 2, 2);
    expect(r2[1]).toBeGreaterThan(r2[0]!);
    expect(r2[0]! + r2[1]!).toBeCloseTo(1, 5);
  });

  it('leaves unreachable nodes at zero and keeps seeds clamped one-hot', () => {
    // seeds 0,1 connected to each other; node 2 isolated
    const w = computeAffinity(3, [0], [1], 1, [0, 1]);
    expect(row(w, 2, 0)).toEqual([1, 0]);
    expect(row(w, 2, 1)).toEqual([0, 1]);
    expect(row(w, 2, 2)).toEqual([0, 0]);
  });

  it('handles zero seeds and out-of-range seed indices without throwing', () => {
    expect(computeAffinity(2, [0], [1], 1, []).length).toBe(0);
    const w = computeAffinity(2, [0], [1], 1, [5]);
    expect(Array.from(w)).toEqual([0, 0]);
  });
});

describe('affinityTargets', () => {
  const k3 = [10, 11, 12]; // seed indices
  const anchors = anchorPositions(3, 100);

  it('lands seeds exactly on their anchors', () => {
    const n = 13;
    const w = new Float32Array(n * 3);
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    // targets pass through a Float32Array, so compare with float32-level tolerance
    for (let j = 0; j < 3; j++) {
      expect(tx[k3[j]!]).toBeCloseTo(anchors[j]!.x, 3);
      expect(ty[k3[j]!]).toBeCloseTo(anchors[j]!.y, 3);
    }
  });

  it('pushes a single-seed paper radially beyond its anchor', () => {
    const n = 13;
    const w = new Float32Array(n * 3);
    w[0 * 3 + 1] = 1; // node 0 belongs entirely to seed 1
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    const a = anchors[1]!;
    // collinear with the anchor ray, farther from the origin than the anchor
    expect(tx[0]! * a.y - ty[0]! * a.x).toBeCloseTo(0, 3);
    expect(Math.hypot(tx[0]!, ty[0]!)).toBeGreaterThan(Math.hypot(a.x, a.y));
    expect(tx[0]! * a.x + ty[0]! * a.y).toBeGreaterThan(0); // same side, not mirrored
  });

  it('puts an evenly shared paper near the center and an unreached one at NaN', () => {
    const n = 13;
    const w = new Float32Array(n * 3);
    for (let j = 0; j < 3; j++) w[0 * 3 + j] = 1 / 3;
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    expect(Math.hypot(tx[0]!, ty[0]!)).toBeLessThan(1e-3); // symmetric barycenter is the origin
    expect(tx[1]).toBeNaN();
    expect(ty[1]).toBeNaN();
  });

  it('fans same-seed papers into distinct pre-spaced targets beyond their anchor', () => {
    // shared targets would make the target force fight collide every tick (visible wiggle)
    const n = 13;
    const w = new Float32Array(n * 3);
    for (const i of [0, 1, 2]) w[i * 3 + 1] = 1; // three papers belonging entirely to seed 1
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    const a = anchors[1]!;
    const anchorDist = Math.hypot(a.x, a.y);
    for (const i of [0, 1, 2]) {
      expect(Math.hypot(tx[i]!, ty[i]!)).toBeGreaterThan(anchorDist); // outside the anchor circle
      expect(tx[i]! * a.x + ty[i]! * a.y).toBeGreaterThan(0); // on that seed's side
    }
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
      expect(Math.hypot(tx[i]! - tx[j]!, ty[i]! - ty[j]!)).toBeGreaterThan(10);
    }
  });

  it('spreads nodes with an identical mixed signature around their shared point', () => {
    const n = 13;
    const w = new Float32Array(n * 3);
    for (const i of [0, 1]) {
      w[i * 3 + 0] = 0.5;
      w[i * 3 + 1] = 0.5;
    }
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    const d = Math.hypot(tx[0]! - tx[1]!, ty[0]! - ty[1]!);
    expect(d).toBeGreaterThan(10); // no longer the same point…
    expect(d).toBeLessThan(25); // …but still one visual cluster
  });

  it('places a two-seed bridge between its anchors, closer than either anchor', () => {
    const n = 13;
    const w = new Float32Array(n * 3);
    w[0 * 3 + 0] = 0.5;
    w[0 * 3 + 1] = 0.5;
    const tx = new Float32Array(n);
    const ty = new Float32Array(n);
    affinityTargets(w, k3, anchors, n, tx, ty);
    const r = anchorRadius(3, 100);
    expect(Math.hypot(tx[0]!, ty[0]!)).toBeLessThan(r);
    expect(Math.hypot(tx[0]!, ty[0]!)).toBeGreaterThan(0);
  });
});

describe('anchorPositions / anchorRadius', () => {
  it('degenerates gracefully: none → [], one → origin (radius 0)', () => {
    expect(anchorPositions(0, 50)).toEqual([]);
    expect(anchorPositions(1, 50)).toEqual([{ x: 0, y: 0 }]);
    expect(anchorRadius(1, 500)).toBe(0);
  });

  it('spaces k anchors on the shared radius, first at 12 o’clock', () => {
    const pts = anchorPositions(4, 200);
    const r = anchorRadius(4, 200);
    expect(pts).toHaveLength(4);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(r, 5);
    expect(pts[0]!.x).toBeCloseTo(0, 5);
    expect(pts[0]!.y).toBeCloseTo(-r, 5);
  });

  it('radius grows with seed count and map size', () => {
    expect(anchorRadius(8, 100)).toBeGreaterThan(anchorRadius(2, 100));
    expect(anchorRadius(2, 2000)).toBeGreaterThan(anchorRadius(2, 100));
  });
});

describe('orderSeeds', () => {
  const refs: Record<string, string[]> = {
    a: ['r1', 'r2', 'r3'],
    b: ['r1', 'r2', 'r4'],
    c: ['x1', 'x2'],
    d: ['x1', 'x2', 'x3'],
  };
  it('puts seeds with overlapping reference lists on adjacent anchors', () => {
    const out = orderSeeds(['a', 'c', 'b', 'd'], (id) => refs[id]);
    const at = (id: string) => out.indexOf(id);
    expect(Math.abs(at('a') - at('b'))).toBe(1);
    expect(Math.abs(at('c') - at('d'))).toBe(1);
  });
  it('keeps input order when no lists are cached, and passes short inputs through', () => {
    expect(orderSeeds(['a', 'b', 'c'], () => undefined)).toEqual(['a', 'b', 'c']);
    expect(orderSeeds(['a', 'b'], (id) => refs[id])).toEqual(['a', 'b']);
    expect(orderSeeds([], () => undefined)).toEqual([]);
  });
});
