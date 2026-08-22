import type { LabelMode } from '../types';
import { FLAG_EXPANDED, FLAG_EXPANDING, FLAG_PINNED, FLAG_SEED, type FrameData } from './frame';

export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

export interface GraphTheme {
  bg: string;
  edge: string;
  edgeHi: string;
  node: string[]; // by role 0..4
  ring: string;
  label: string;
  labelHalo: string;
  accent: string;
  muted: string;
}

const FALLBACK: GraphTheme = {
  bg: '#fbfbf9',
  edge: 'rgba(60,60,55,0.22)',
  edgeHi: '#1f6fb2',
  node: ['#2a97d9', '#5aa844', '#9b4f9f', '#de9b2c', '#a2a29b'],
  ring: '#1d1d1b',
  label: '#2a2a27',
  labelHalo: 'rgba(251,251,249,0.9)',
  accent: '#1f6fb2',
  muted: '#9a9a93',
};

/** Read the graph palette from CSS custom properties (once per theme change). */
export function readTheme(el: Element): GraphTheme {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    bg: v('--graph-bg', FALLBACK.bg),
    edge: v('--edge', FALLBACK.edge),
    edgeHi: v('--edge-hi', FALLBACK.edgeHi),
    node: [v('--node-seed', FALLBACK.node[0]!), v('--node-cited', FALLBACK.node[1]!), v('--node-citing', FALLBACK.node[2]!), v('--node-both', FALLBACK.node[3]!), v('--node-isolated', FALLBACK.node[4]!)],
    ring: v('--node-ring', FALLBACK.ring),
    label: v('--label', FALLBACK.label),
    labelHalo: v('--label-halo', FALLBACK.labelHalo),
    accent: v('--accent', FALLBACK.accent),
    muted: v('--text-faint', FALLBACK.muted),
  };
}

export interface DrawOptions {
  width: number;
  height: number;
  dpr: number;
  labelMode: LabelMode;
  /** idx set of nodes adjacent to the focus node (hovered ?? selected); null when none. */
  neighbors: Set<number> | null;
  /** idx of the focus node (hovered ?? selected) or -1 */
  focus: number;
  /** idx of the node currently described by the DOM tooltip (its canvas label is skipped), or -1 */
  tooltipIdx: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TWO_PI = Math.PI * 2;

/** Draw one frame. No allocations in the hot loops beyond the per-role batches. */
export function drawFrame(ctx: CanvasRenderingContext2D, f: FrameData, view: ViewTransform, theme: GraphTheme, o: DrawOptions): void {
  const { width, height, dpr } = o;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  if (f.n === 0) return;

  const k = view.k;
  ctx.translate(view.x, view.y);
  ctx.scale(k, k);

  // visible world bounds (+margin)
  const margin = 40 / k;
  const x0 = -view.x / k - margin;
  const y0 = -view.y / k - margin;
  const x1 = (width - view.x) / k + margin;
  const y1 = (height - view.y) / k + margin;
  const pos = f.pos;
  const focus = o.focus;
  const dim = focus >= 0;

  // ---- edges ----
  ctx.lineWidth = Math.max(0.6, 1) / k;
  ctx.strokeStyle = theme.edge;
  ctx.globalAlpha = dim ? 0.35 : 1;
  ctx.beginPath();
  for (let i = 0; i < f.m; i++) {
    const a = f.edgeSrc[i]!;
    const b = f.edgeDst[i]!;
    if (dim && (a === focus || b === focus)) continue;
    const ax = pos[2 * a]!;
    const ay = pos[2 * a + 1]!;
    const bx = pos[2 * b]!;
    const by = pos[2 * b + 1]!;
    if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // highlighted edges of the focus node
  if (dim) {
    ctx.strokeStyle = theme.edgeHi;
    ctx.lineWidth = 1.6 / k;
    ctx.beginPath();
    for (let i = 0; i < f.m; i++) {
      const a = f.edgeSrc[i]!;
      const b = f.edgeDst[i]!;
      if (a !== focus && b !== focus) continue;
      ctx.moveTo(pos[2 * a]!, pos[2 * a + 1]!);
      ctx.lineTo(pos[2 * b]!, pos[2 * b + 1]!);
    }
    ctx.stroke();
    // arrowheads on highlighted edges (direction: citing → cited)
    drawArrows(ctx, f, focus, theme.edgeHi, k);
  }

  // ---- nodes, batched per role ----
  const neighbors = o.neighbors;
  for (let pass = 0; pass < 2; pass++) {
    // pass 0: dimmed nodes, pass 1: normal/highlighted (drawn on top)
    for (let role = 4; role >= 0; role--) {
      ctx.fillStyle = theme.node[role]!;
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < f.n; i++) {
        if (f.role[i] !== role) continue;
        const isDim = dim && i !== focus && !(neighbors && neighbors.has(i));
        if ((pass === 0) !== isDim) continue;
        const x = pos[2 * i]!;
        const y = pos[2 * i + 1]!;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const r = f.r[i]!;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TWO_PI);
        any = true;
      }
      if (any) {
        ctx.globalAlpha = pass === 0 ? 0.25 : 1;
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  // ---- rings: seeds, expanded, pinned, focus ----
  ctx.lineWidth = 1.5 / k;
  for (let i = 0; i < f.n; i++) {
    const fl = f.flags[i]!;
    const x = pos[2 * i]!;
    const y = pos[2 * i + 1]!;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const r = f.r[i]!;
    const isDim = dim && i !== focus && !(neighbors && neighbors.has(i));
    if (isDim) continue;
    if (fl & FLAG_SEED) {
      ctx.strokeStyle = theme.ring;
      ctx.lineWidth = 2 / k;
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5 / k, 0, TWO_PI);
      ctx.stroke();
    } else if (fl & FLAG_EXPANDED) {
      ctx.strokeStyle = theme.ring;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2 / k;
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5 / k, 0, TWO_PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (fl & FLAG_PINNED) {
      ctx.fillStyle = theme.ring;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, r * 0.28), 0, TWO_PI);
      ctx.fill();
    }
    if (fl & FLAG_EXPANDING) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / k;
      ctx.setLineDash([3 / k, 3 / k]);
      ctx.beginPath();
      ctx.arc(x, y, r + 5 / k, 0, TWO_PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (f.selected >= 0) ring(ctx, pos, f.r, f.selected, theme.accent, 2.5 / k, 4 / k);
  if (f.hovered >= 0 && f.hovered !== f.selected) ring(ctx, pos, f.r, f.hovered, theme.accent, 1.5 / k, 3 / k);

  // ---- labels ----
  const px = 11 / k;
  ctx.font = `500 ${px}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 / k;
  ctx.strokeStyle = theme.labelHalo;
  ctx.fillStyle = theme.label;
  const mode = o.labelMode;
  const autoOn = mode === 'all' ? k >= 0.9 : mode === 'auto' ? k >= 1.25 : false;
  const autoMinR = mode === 'all' ? 0 : 9;
  let drawn = 0;
  const MAX_AUTO = 120;
  // Label neighbours of the focus node only when there are few of them (or when zoomed in).
  const labelNeighbors = !!neighbors && (neighbors.size <= 14 || k >= 2.2);
  for (let i = 0; i < f.n; i++) {
    const x = pos[2 * i]!;
    const y = pos[2 * i + 1]!;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const fl = f.flags[i]!;
    const isFocus = i === f.hovered || i === f.selected;
    const isNeighbor = labelNeighbors && neighbors!.has(i) && k >= 0.7;
    let show = isFocus || (fl & FLAG_SEED) !== 0 || isNeighbor;
    if (!show && autoOn && drawn < MAX_AUTO && f.r[i]! >= autoMinR) show = true;
    if (!show) continue;
    if (dim && !isFocus && !isNeighbor && !(fl & FLAG_SEED)) continue;
    if (i === o.tooltipIdx) continue; // the tooltip card already shows this paper
    const text = f.labels[i]!;
    const lx = x + f.r[i]! + 4 / k;
    if (isFocus) ctx.font = `600 ${px}px ${FONT}`;
    ctx.strokeText(text, lx, y);
    ctx.fillText(text, lx, y);
    if (isFocus) ctx.font = `500 ${px}px ${FONT}`;
    if (!isFocus && !(fl & FLAG_SEED)) drawn++;
  }
}

function ring(ctx: CanvasRenderingContext2D, pos: Float32Array, rr: Float32Array, i: number, color: string, lw: number, pad: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(pos[2 * i]!, pos[2 * i + 1]!, rr[i]! + pad, 0, TWO_PI);
  ctx.stroke();
}

function drawArrows(ctx: CanvasRenderingContext2D, f: FrameData, focus: number, color: string, k: number): void {
  const pos = f.pos;
  const size = 6 / k;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < f.m; i++) {
    const a = f.edgeSrc[i]!;
    const b = f.edgeDst[i]!;
    if (a !== focus && b !== focus) continue;
    const ax = pos[2 * a]!;
    const ay = pos[2 * a + 1]!;
    const bx = pos[2 * b]!;
    const by = pos[2 * b + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;
    const ux = dx / len;
    const uy = dy / len;
    // tip sits on the target circle edge
    const tx = bx - ux * (f.r[b]! + 1.5 / k);
    const ty = by - uy * (f.r[b]! + 1.5 / k);
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * size - uy * size * 0.5, ty - uy * size + ux * size * 0.5);
    ctx.lineTo(tx - ux * size + uy * size * 0.5, ty - uy * size - ux * size * 0.5);
    ctx.closePath();
  }
  ctx.fill();
}
