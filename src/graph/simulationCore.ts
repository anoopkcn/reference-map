import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { DEFAULT_SIM_PARAMS, type SimParams } from './protocol';

export interface SimNode extends SimulationNodeDatum {
  idx: number;
  r: number;
  x: number;
  y: number;
}
export interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode;
  target: SimNode;
}

/** Worker-agnostic wrapper around d3-force; ticks are driven manually. */
export class SimulationCore {
  readonly nodes: SimNode[] = [];
  readonly links: SimLink[] = [];
  readonly sim: Simulation<SimNode, SimLink>;
  private params: SimParams;
  private linkForce = forceLink<SimNode, SimLink>();
  private rng = mulberry32(7);

  constructor(params: Partial<SimParams> = {}) {
    this.params = { ...DEFAULT_SIM_PARAMS, ...params };
    const p = this.params;
    this.linkForce = forceLink<SimNode, SimLink>().distance((l) => p.linkDistance + l.source.r + l.target.r);
    this.sim = forceSimulation<SimNode>([])
      .stop()
      .alphaDecay(p.alphaDecay)
      .velocityDecay(p.velocityDecay)
      .alphaMin(p.alphaMin)
      .force('link', this.linkForce)
      .force('charge', forceManyBody<SimNode>().strength(p.charge).distanceMax(p.chargeDistanceMax).theta(0.9))
      .force('collide', forceCollide<SimNode>((n) => n.r + p.collidePadding).iterations(1))
      .force('x', forceX<SimNode>(0).strength(p.centerStrength))
      .force('y', forceY<SimNode>(0).strength(p.centerStrength));
  }

  get count(): number {
    return this.nodes.length;
  }
  get alpha(): number {
    return this.sim.alpha();
  }
  get alphaMin(): number {
    return this.params.alphaMin;
  }

  addNodes(r: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>): void {
    const base = this.nodes.length;
    for (let i = 0; i < r.length; i++) {
      const px = x[i];
      const py = y[i];
      const ok = px !== undefined && py !== undefined && Number.isFinite(px) && Number.isFinite(py);
      this.nodes.push({
        idx: base + i,
        r: r[i] ?? 3,
        x: ok ? px : (this.rng() - 0.5) * 40,
        y: ok ? py : (this.rng() - 0.5) * 40,
        vx: 0,
        vy: 0,
      });
    }
    this.sim.nodes(this.nodes);
  }

  addLinks(src: ArrayLike<number>, dst: ArrayLike<number>): void {
    for (let i = 0; i < src.length; i++) {
      const s = this.nodes[src[i]!];
      const t = this.nodes[dst[i]!];
      if (s && t) this.links.push({ source: s, target: t });
    }
    this.linkForce.links(this.links);
  }

  setRadii(r: ArrayLike<number>): void {
    const n = Math.min(r.length, this.nodes.length);
    for (let i = 0; i < n; i++) this.nodes[i]!.r = r[i]!;
    // re-initialise forces that cache radii/distances
    this.sim.nodes(this.nodes);
    this.linkForce.links(this.links);
  }

  reset(r: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>, pinned: ArrayLike<number>, src: ArrayLike<number>, dst: ArrayLike<number>): void {
    this.nodes.length = 0;
    this.links.length = 0;
    this.addNodes(r, x, y);
    for (let i = 0; i < this.nodes.length; i++) {
      if (pinned[i]) {
        const n = this.nodes[i]!;
        n.fx = n.x;
        n.fy = n.y;
      }
    }
    this.addLinks(src, dst);
  }

  drag(idx: number, x: number, y: number): void {
    const n = this.nodes[idx];
    if (!n) return;
    n.fx = x;
    n.fy = y;
    this.sim.alphaTarget(0.3);
    if (this.sim.alpha() < 0.3) this.sim.alpha(0.3);
  }

  dragEnd(idx: number, pin: boolean): void {
    const n = this.nodes[idx];
    this.sim.alphaTarget(0);
    if (!n) return;
    if (!pin) {
      n.fx = null;
      n.fy = null;
    }
  }

  pin(idx: number, x: number, y: number): void {
    const n = this.nodes[idx];
    if (!n) return;
    n.fx = n.x = x;
    n.fy = n.y = y;
  }

  unpin(idx: number): void {
    const n = this.nodes[idx];
    if (!n) return;
    n.fx = null;
    n.fy = null;
  }

  unpinAll(): void {
    for (const n of this.nodes) {
      n.fx = null;
      n.fy = null;
    }
  }

  reheat(alpha: number): void {
    if (this.sim.alpha() < alpha) this.sim.alpha(alpha);
  }

  /** Advance one step; returns the new alpha. */
  tick(): number {
    this.sim.tick();
    return this.sim.alpha();
  }

  /** Write interleaved x,y into buf (must hold 2*count floats). */
  writePositions(buf: Float32Array): void {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      buf[2 * i] = n.x;
      buf[2 * i + 1] = n.y;
    }
  }
}

/** Small deterministic PRNG so layouts are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
