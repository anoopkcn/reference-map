import type { AppStore } from '../store/store';
import type { LayoutMode } from '../types';
import { ensureEdgeCapacity, ensureNodeCapacity, FLAG_EXPANDED, FLAG_EXPANDING, FLAG_PINNED, FLAG_SEED, type FrameData } from './frame';
import { affinityTargets, anchorPositions, computeAffinity, orderSeeds } from './confluence';
import type { MainToWorker, WorkerToMain } from './protocol';
import { citationsToY, yearDomain, yearToX } from './timeline';

export interface BridgeCallbacks {
  /** Positions changed (draw). */
  onTick: (alpha: number) => void;
  /** Structure/flags changed (draw; recompute derived things). */
  onStructure: () => void;
  /** Simulation settled. */
  onEnd: () => void;
}

/**
 * Keeps the layout worker and the render frame in sync with the store's GraphModel.
 * Main-thread side of the protocol: drains GraphModel diffs → worker messages; worker ticks → frame positions.
 */
export class GraphBridge {
  readonly frame: FrameData;
  private worker: Worker;
  private unsub: () => void;
  private ready = false;
  private queued: { msg: MainToWorker; transfer?: Transferable[] }[] = [];
  private lastVersionSeen = -1;
  /** Layout mode last pushed to the worker; it self-initializes in force mode. */
  private lastMode: LayoutMode = 'force';
  /** Targets last sent to the worker (kept to skip no-op sends — each send reheats the sim). */
  private lastTx: Float32Array | null = null;
  private lastTy: Float32Array | null = null;
  private rng = 1;
  private active = true;
  private pendingTick: Extract<WorkerToMain, { t: 'tick' }> | null = null;

  constructor(private store: AppStore, frame: FrameData, private cb: BridgeCallbacks) {
    this.frame = frame;
    this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerToMain>) => this.onMessage(e.data);
    this.unsub = store.subscribe((s, prev) => {
      if (s.graphVersion !== prev.graphVersion) this.sync();
      if (s.settings.layoutMode !== prev.settings.layoutMode) this.syncMode();
      if (s.selectedId !== prev.selectedId || s.hoveredId !== prev.hoveredId) this.syncFocus();
      if (s.expanding !== prev.expanding) this.syncExpanding(prev.expanding);
    });
    // initial sync (the graph may already have content); mode after structure so targets
    // arrive for indices the worker already knows about
    this.sync(true);
    this.syncMode();
    this.syncFocus();
  }

  destroy(): void {
    this.unsub();
    this.releaseTick();
    this.worker.terminate();
  }

  private send(msg: MainToWorker, transfer?: Transferable[]): void {
    if (!this.ready) {
      this.queued.push({ msg, transfer });
      return;
    }
    this.worker.postMessage(msg, transfer ?? []);
  }

  private onMessage(m: WorkerToMain): void {
    if (m.t === 'ready') {
      this.ready = true;
      const q = this.queued;
      this.queued = [];
      for (const { msg, transfer } of q) this.worker.postMessage(msg, transfer ?? []);
      return;
    }
    if (m.t === 'tick') {
      if (!this.active) {
        this.worker.postMessage({ t: 'buffer', pos: m.pos } satisfies MainToWorker, [m.pos.buffer]);
        return;
      }
      this.releaseTick();
      this.pendingTick = m;
      this.cb.onTick(m.alpha);
      return;
    }
    if (m.t === 'end') this.cb.onEnd();
  }

  /** Pull structural changes from the GraphModel into the frame and the worker. */
  sync(force = false): void {
    const s = this.store.getState();
    const g = s.graph;
    if (!force && g.version === this.lastVersionSeen) return;
    this.releaseTick();
    this.lastVersionSeen = g.version;
    const diff = g.drainDiff();
    const f = this.frame;

    if (diff.reset || force) {
      // Preserve positions of surviving nodes by id.
      const prevPos = new Map<string, [number, number]>();
      for (let i = 0; i < f.n; i++) prevPos.set(f.ids[i]!, [f.pos[2 * i]!, f.pos[2 * i + 1]!]);
      const n = g.order.length;
      ensureNodeCapacity(f, n);
      const r = new Float32Array(n);
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      const pinned = new Uint8Array(n);
      f.ids.length = n;
      f.labels.length = n;
      f.titles.length = n;
      for (let i = 0; i < n; i++) {
        const id = g.order[i]!;
        const node = g.nodes.get(id)!;
        const p = prevPos.get(id);
        const px = p ? p[0] : this.seedPos(i)[0];
        const py = p ? p[1] : this.seedPos(i)[1];
        x[i] = px;
        y[i] = py;
        f.pos[2 * i] = px;
        f.pos[2 * i + 1] = py;
        r[i] = node.r;
        pinned[i] = node.pinned ? 1 : 0;
        f.ids[i] = id;
      }
      f.n = n;
      const m = g.edgeSrc.length;
      ensureEdgeCapacity(f, m);
      for (let i = 0; i < m; i++) {
        f.edgeSrc[i] = g.edgeSrc[i]!;
        f.edgeDst[i] = g.edgeDst[i]!;
      }
      f.m = m;
      const src = Int32Array.from(g.edgeSrc);
      const dst = Int32Array.from(g.edgeDst);
      this.send({ t: 'reset', r, x, y, pinned, src, dst }, [r.buffer, x.buffer, y.buffer, pinned.buffer, src.buffer, dst.buffer]);
    } else {
      if (diff.newNodes.length) {
        const k = diff.newNodes.length;
        const n = g.order.length;
        ensureNodeCapacity(f, n);
        f.ids.length = n;
        f.labels.length = n;
        f.titles.length = n;
        const r = new Float32Array(k);
        const x = new Float32Array(k);
        const y = new Float32Array(k);
        for (let j = 0; j < k; j++) {
          const idx = diff.newNodes[j]!;
          const parent = diff.parents[j]!;
          const id = g.order[idx]!;
          const node = g.nodes.get(id)!;
          let px: number;
          let py: number;
          if (parent >= 0 && parent < f.n) {
            const a = this.rand() * Math.PI * 2;
            const d = 20 + this.rand() * 40;
            px = f.pos[2 * parent]! + Math.cos(a) * d;
            py = f.pos[2 * parent + 1]! + Math.sin(a) * d;
          } else {
            [px, py] = this.seedPos(idx);
          }
          x[j] = px;
          y[j] = py;
          f.pos[2 * idx] = px;
          f.pos[2 * idx + 1] = py;
          r[j] = node.r;
          f.ids[idx] = id;
        }
        f.n = n;
        this.send({ t: 'addNodes', r, x, y }, [r.buffer, x.buffer, y.buffer]);
      }
      if (diff.newEdges.length) {
        const k = diff.newEdges.length / 2;
        const src = new Int32Array(k);
        const dst = new Int32Array(k);
        const m0 = f.m;
        ensureEdgeCapacity(f, m0 + k);
        for (let j = 0; j < k; j++) {
          src[j] = diff.newEdges[2 * j]!;
          dst[j] = diff.newEdges[2 * j + 1]!;
          f.edgeSrc[m0 + j] = src[j]!;
          f.edgeDst[m0 + j] = dst[j]!;
        }
        f.m = m0 + k;
        this.send({ t: 'addLinks', src, dst }, [src.buffer, dst.buffer]);
      }
      if (diff.radiiChanged && f.n > 0) {
        const r = new Float32Array(f.n);
        for (let i = 0; i < f.n; i++) r[i] = g.nodes.get(f.ids[i]!)!.r;
        this.send({ t: 'setRadii', r }, [r.buffer]);
      }
    }

    // Refresh per-node attributes (cheap, O(n)).
    for (let i = 0; i < f.n; i++) {
      const node = g.nodes.get(f.ids[i]!)!;
      const paper = s.papers.get(node.id);
      f.r[i] = node.r;
      f.role[i] = node.role;
      f.year[i] = paper?.year ?? 0;
      f.labels[i] = node.label;
      f.titles[i] = paper?.title ?? node.label;
      let fl = 0;
      if (node.seed) fl |= FLAG_SEED;
      if (node.pinned) fl |= FLAG_PINNED;
      if (node.expanded) fl |= FLAG_EXPANDED;
      if (s.expanding.has(node.id)) fl |= FLAG_EXPANDING;
      f.flags[i] = fl;
    }
    // After a reset/addNodes the worker's nodes are fresh and their targets are lost — force
    // a resend then; otherwise skip no-op sends so revalidation syncs don't keep the sim hot.
    if (this.lastMode !== 'force') this.sendTargets(diff.reset || force || diff.newNodes.length > 0);
    f.version++;
    this.syncFocus(false);
    this.cb.onStructure();
    if (!this.active) this.send({ t: 'stop' });
  }

  /** Push the layout mode (and, for target-driven modes, fresh targets) to the worker. */
  private syncMode(): void {
    const mode = this.store.getState().settings.layoutMode;
    if (mode === this.lastMode) return;
    this.lastMode = mode;
    this.send({ t: 'mode', mode });
    if (mode !== 'force') this.sendTargets(true);
    this.cb.onStructure(); // redraw now so axes appear/disappear immediately
    if (!this.active) this.send({ t: 'stop' });
  }

  /**
   * Compute and send per-node targets for the current mode. Always sent after structural
   * messages within a sync — postMessage is FIFO, so the worker sees indices before their
   * targets. Arrays are cloned by postMessage (not transferred) so they can be kept for the
   * no-op comparison; sends are per structural change, not per tick.
   */
  private sendTargets(force: boolean): void {
    const tx = new Float32Array(this.frame.n);
    const ty = new Float32Array(this.frame.n);
    if (this.lastMode === 'confluence') this.confluenceTargets(tx, ty);
    else this.timelineTargets(tx, ty);
    if (!force && this.lastTx && this.lastTy && targetsEqual(tx, this.lastTx) && targetsEqual(ty, this.lastTy)) return;
    this.lastTx = tx;
    this.lastTy = ty;
    this.send({ t: 'targets', x: tx, y: ty });
  }

  /** Timeline targets: x from year (NaN when unknown), y from log citation count. */
  private timelineTargets(tx: Float32Array, ty: Float32Array): void {
    const f = this.frame;
    const g = this.store.getState().graph;
    const d = yearDomain(f.year, f.n);
    for (let i = 0; i < f.n; i++) {
      const yr = f.year[i]!;
      tx[i] = d && yr > 0 ? yearToX(yr, d) : NaN;
      ty[i] = citationsToY(g.nodes.get(f.ids[i]!)?.citationCount ?? 0);
    }
  }

  /**
   * Confluence targets: seeds anchored on a circle (ordered so seeds with overlapping cached
   * reference lists sit next to each other), every other node at the specificity-pushed
   * barycenter of its seed-affinity vector. Structure-only inputs, so the no-op comparison
   * in sendTargets naturally absorbs attribute-only syncs.
   */
  private confluenceTargets(tx: Float32Array, ty: Float32Array): void {
    const s = this.store.getState();
    const g = s.graph;
    const f = this.frame;
    const ordered = orderSeeds([...g.seeds], (id) => s.lists.get(id)?.refs?.ids);
    const seedIdx: number[] = [];
    for (const id of ordered) {
      const idx = g.nodes.get(id)?.idx;
      if (idx !== undefined && idx < f.n) seedIdx.push(idx);
    }
    const anchors = anchorPositions(seedIdx.length, f.n);
    const weights = computeAffinity(f.n, f.edgeSrc, f.edgeDst, f.m, seedIdx);
    affinityTargets(weights, seedIdx, anchors, f.n, tx, ty);
  }

  private syncFocus(notify = true): void {
    const s = this.store.getState();
    const f = this.frame;
    const idxOf = (id: string | null) => (id ? (s.graph.getNode(id)?.idx ?? -1) : -1);
    const hovered = idxOf(s.hoveredId);
    const selected = idxOf(s.selectedId);
    let changed = false;
    if (hovered !== f.hovered) {
      f.hovered = hovered;
      changed = true;
    }
    if (selected !== f.selected) {
      f.selected = selected;
      changed = true;
    }
    if (changed && notify) this.cb.onStructure();
  }

  private syncExpanding(previous: ReadonlySet<string>): void {
    const s = this.store.getState();
    let changed = false;
    for (const id of previous) {
      if (s.expanding.has(id)) continue;
      const idx = s.graph.getNode(id)?.idx;
      if (idx !== undefined && idx < this.frame.n) {
        this.frame.flags[idx] = this.frame.flags[idx]! & ~FLAG_EXPANDING;
        changed = true;
      }
    }
    for (const id of s.expanding) {
      if (previous.has(id)) continue;
      const idx = s.graph.getNode(id)?.idx;
      if (idx !== undefined && idx < this.frame.n) {
        this.frame.flags[idx] = this.frame.flags[idx]! | FLAG_EXPANDING;
        changed = true;
      }
    }
    if (changed) this.cb.onStructure();
  }

  /** Apply at most one worker position buffer per rendered animation frame. */
  consumeTick(): void {
    const tick = this.pendingTick;
    if (!tick) return;
    this.pendingTick = null;
    const n = Math.min(tick.n, this.frame.n);
    if (n > 0) this.frame.pos.set(tick.pos.subarray(0, 2 * n));
    this.frame.alpha = tick.alpha;
    this.worker.postMessage({ t: 'buffer', pos: tick.pos } satisfies MainToWorker, [tick.pos.buffer]);
  }

  private releaseTick(): void {
    const tick = this.pendingTick;
    if (!tick) return;
    this.pendingTick = null;
    this.worker.postMessage({ t: 'buffer', pos: tick.pos } satisfies MainToWorker, [tick.pos.buffer]);
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      this.releaseTick();
      this.send({ t: 'stop' });
    } else {
      this.send({ t: 'reheat', alpha: Math.max(0.05, this.frame.alpha) });
      this.cb.onStructure();
    }
  }

  /** Deterministic starting position for a node without a parent: small spiral around the origin. */
  private seedPos(i: number): [number, number] {
    const a = i * 2.39996; // golden angle
    const d = 12 * Math.sqrt(i + 1);
    return [Math.cos(a) * d, Math.sin(a) * d];
  }

  private rand(): number {
    this.rng = (this.rng * 48271) % 2147483647;
    return this.rng / 2147483647;
  }

  // ---- imperative controls ----
  drag(idx: number, x: number, y: number): void {
    const f = this.frame;
    f.pos[2 * idx] = x;
    f.pos[2 * idx + 1] = y;
    this.send({ t: 'drag', idx, x, y });
  }
  dragEnd(idx: number, pin: boolean): void {
    this.send({ t: 'dragEnd', idx, pin });
    const id = this.frame.ids[idx];
    if (id) this.store.getState().setPinned(id, pin);
  }
  unpin(idx: number): void {
    this.send({ t: 'unpin', idx });
    const id = this.frame.ids[idx];
    if (id) this.store.getState().setPinned(id, false);
  }
  unpinAll(): void {
    this.send({ t: 'unpinAll' });
    this.store.getState().unpinAll();
  }
  reheat(alpha = 0.6): void {
    this.send({ t: 'reheat', alpha });
  }
}

function targetsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}
