import { NodeRole, type LabelMode, type LayoutMode } from '../types';
import { anchorRadius } from './confluence';
import { FLAG_EXPANDED, FLAG_EXPANDING, FLAG_PINNED, FLAG_SEED, roleIsVisible, type FrameData } from './frame';
import { citationTickStep, citationsToY, formatCount, yearDomain, yearTickStep, yearToX, type YearDomain } from './timeline';

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
  /** confluence seed hues by anchor slot (wraps past 8) */
  seeds: string[];
  /** neutral fill of multi-seed discs in confluence mode */
  disc: string;
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
  seeds: ['#2a78d6', '#eda100', '#e87ba4', '#008300', '#eb6834', '#1baf7a', '#4a3aa7', '#e34948'],
  disc: '#eae8e0',
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
    seeds: FALLBACK.seeds.map((fb, i) => v(`--seed-${i + 1}`, fb)),
    disc: v('--node-disc', FALLBACK.disc),
  };
}

export interface DrawOptions {
  width: number;
  height: number;
  dpr: number;
  labelMode: LabelMode;
  layoutMode: LayoutMode;
  /** idx set of nodes adjacent to the focus node (hovered ?? selected); null when none. */
  neighbors: Set<number> | null;
  /** idx of the focus node (hovered ?? selected) or -1 */
  focus: number;
  /** idx of the node currently described by the DOM tooltip (its canvas label is skipped), or -1 */
  tooltipIdx: number;
  /** Bit mask of node roles to render. */
  visibleRoleMask: number;
  /** Screen px along the bottom edge covered by overlays (legend) — axis labels sit above it. */
  bottomInset: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TWO_PI = Math.PI * 2;

// Older papers are drawn more transparent; years are quantized into buckets so fills stay batched.
const AGE_BUCKETS = 8;
const AGE_MIN_ALPHA = 0.3;
let ageBucket = new Uint8Array(0);

// Timeline axes.
const AXIS_GRID_ALPHA = 0.15;
const AXIS_FONT_PX = 10;
const AXIS_PAD = 6;

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
  const visible = (index: number) => roleIsVisible(o.visibleRoleMask, f.role[index]!);
  const focus = o.focus >= 0 && visible(o.focus) ? o.focus : -1;
  const dim = focus >= 0;
  const dom = yearDomain(f.year, f.n);

  // ---- layout scenery (under everything) ----
  if (o.layoutMode === 'timeline') drawTimelineAxes(ctx, view, theme, o, dom, x0, y0, x1, y1);
  else if (o.layoutMode === 'confluence') drawConfluenceWashes(ctx, f, theme, pos, x0, y0, x1, y1);

  // ---- edges ----
  ctx.lineWidth = Math.max(0.6, 1) / k;
  ctx.strokeStyle = theme.edge;
  ctx.globalAlpha = dim ? 0.35 : 1;
  ctx.beginPath();
  for (let i = 0; i < f.m; i++) {
    const a = f.edgeSrc[i]!;
    const b = f.edgeDst[i]!;
    if (!visible(a) || !visible(b)) continue;
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

  // highlighted edges of the focus node (in seed-coloured modes, edges to a seed take its hue)
  if (dim) {
    ctx.lineWidth = 1.6 / k;
    if (o.layoutMode !== 'force') {
      for (let i = 0; i < f.m; i++) {
        const a = f.edgeSrc[i]!;
        const b = f.edgeDst[i]!;
        if (!visible(a) || !visible(b)) continue;
        if (a !== focus && b !== focus) continue;
        const other = a === focus ? b : a;
        const slot = f.seedSlot[other]! >= 0 ? f.seedSlot[other]! : f.seedSlot[focus]!;
        ctx.strokeStyle = slot >= 0 ? theme.seeds[slot % theme.seeds.length]! : theme.edgeHi;
        ctx.beginPath();
        ctx.moveTo(pos[2 * a]!, pos[2 * a + 1]!);
        ctx.lineTo(pos[2 * b]!, pos[2 * b + 1]!);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = theme.edgeHi;
      ctx.beginPath();
      for (let i = 0; i < f.m; i++) {
        const a = f.edgeSrc[i]!;
        const b = f.edgeDst[i]!;
        if (!visible(a) || !visible(b)) continue;
        if (a !== focus && b !== focus) continue;
        ctx.moveTo(pos[2 * a]!, pos[2 * a + 1]!);
        ctx.lineTo(pos[2 * b]!, pos[2 * b + 1]!);
      }
      ctx.stroke();
    }
    // arrowheads on highlighted edges (direction: citing → cited)
    drawArrows(ctx, f, focus, theme.edgeHi, k, o.visibleRoleMask);
  }

  // ---- nodes ----
  const neighbors = o.neighbors;
  if (o.layoutMode !== 'force') {
    // Confluence and timeline: colour = seed membership, shape = direction (no age fade —
    // position already encodes structure/year there).
    drawSeedColouredNodes(ctx, f, theme, pos, x0, y0, x1, y1, k, visible, dim, focus, neighbors);
  } else {
    // Batched per role and age bucket.
    const yrMin = dom?.min ?? 0;
    const yrSpan = dom ? dom.max - dom.min : 0;
    const fade = o.layoutMode === 'force' && yrSpan > 0;
    if (ageBucket.length < f.n) ageBucket = new Uint8Array(f.n);
    for (let i = 0; i < f.n; i++) {
      const yr = f.year[i]!;
      // unknown years and degenerate ranges render fully opaque
      ageBucket[i] = fade && yr > 0 ? Math.round(((yr - yrMin) / yrSpan) * (AGE_BUCKETS - 1)) : AGE_BUCKETS - 1;
    }
    for (let pass = 0; pass < 2; pass++) {
      // pass 0: dimmed nodes, pass 1: normal/highlighted (drawn on top)
      for (let role = 4; role >= 0; role--) {
        ctx.fillStyle = theme.node[role]!;
        for (let bucket = 0; bucket < AGE_BUCKETS; bucket++) {
          ctx.beginPath();
          let any = false;
          for (let i = 0; i < f.n; i++) {
            if (f.role[i] !== role) continue;
            if (ageBucket[i] !== bucket) continue;
            if (!visible(i)) continue;
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
            ctx.globalAlpha = (pass === 0 ? 0.25 : 1) * (AGE_MIN_ALPHA + ((1 - AGE_MIN_ALPHA) * bucket) / (AGE_BUCKETS - 1));
            ctx.fill();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- rings: seeds, expanded, pinned, focus ----
  const spinAngle = ((performance.now() % 1000) / 1000) * TWO_PI;
  ctx.lineWidth = 1.5 / k;
  for (let i = 0; i < f.n; i++) {
    if (!visible(i)) continue;
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
      // spinner: faint full track + bright arc circling once per second; GraphCanvas
      // keeps scheduling frames while anything is expanding so this stays in motion
      const rr = r + 5 / k;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / k;
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TWO_PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, rr, spinAngle, spinAngle + TWO_PI * 0.28);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }
  if (f.selected >= 0 && visible(f.selected)) ring(ctx, pos, f.r, f.selected, theme.accent, 2.5 / k, 4 / k);
  if (f.hovered >= 0 && f.hovered !== f.selected && visible(f.hovered)) ring(ctx, pos, f.r, f.hovered, theme.accent, 1.5 / k, 3 / k);

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
    if (!visible(i)) continue;
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

/**
 * Year gridlines (vertical, spanning the data's year domain) and citation-count decade
 * gridlines (horizontal). Drawn inside the world transform; labels stay screen-constant by
 * dividing sizes by k and deriving the viewport edges from the view transform.
 */
function drawTimelineAxes(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  theme: GraphTheme,
  o: DrawOptions,
  dom: YearDomain | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const k = view.k;
  const yearStep = yearTickStep(k);
  const years: number[] = [];
  if (dom) {
    for (let yr = Math.ceil(dom.min / yearStep) * yearStep; yr <= dom.max; yr += yearStep) {
      const x = yearToX(yr, dom);
      if (x < x0 || x > x1) continue;
      years.push(yr);
    }
  }
  const decadeStep = citationTickStep(k);
  const decades: number[] = [];
  for (let e = 0; e <= 9; e += decadeStep) {
    const y = citationsToY(10 ** e);
    if (y < y0) break; // above the viewport (and every later decade is higher still)
    if (y <= y1) decades.push(e);
  }

  // gridlines
  ctx.strokeStyle = theme.muted;
  ctx.globalAlpha = AXIS_GRID_ALPHA;
  ctx.lineWidth = 1 / k;
  ctx.beginPath();
  for (const yr of years) {
    const x = yearToX(yr, dom!);
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (const e of decades) {
    const y = citationsToY(10 ** e);
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // labels: constant screen size/position (screen = world * k + view offset, inverted)
  const px = AXIS_FONT_PX / k;
  ctx.font = `500 ${px}px ${FONT}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 / k;
  ctx.strokeStyle = theme.labelHalo;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const bottomY = (o.height - AXIS_PAD - o.bottomInset - view.y) / k;
  for (const yr of years) {
    const x = yearToX(yr, dom!);
    ctx.strokeText(String(yr), x, bottomY);
    ctx.fillText(String(yr), x, bottomY);
  }
  ctx.textAlign = 'left';
  const leftX = (AXIS_PAD - view.x) / k;
  for (const e of decades) {
    const y = citationsToY(10 ** e) - 3 / k;
    if (y * k + view.y > o.height - o.bottomInset - 4) continue; // would land behind the legend
    const text = formatCount(10 ** e);
    ctx.strokeText(text, leftX, y);
    ctx.fillText(text, leftX, y);
  }
}

/** Alpha of the per-seed territory washes behind the confluence layout. */
const WASH_ALPHA = 0.06;

/** #rrggbb → rgba(); null for anything else (then the wash is simply skipped). */
function hexAlpha(hex: string, a: number): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Faint radial wash in each seed's hue around its anchor — marks the territories the way the
 * prototype did, without hard boundaries. Radius follows the shared anchor geometry so washes
 * scale with the layout.
 */
function drawConfluenceWashes(ctx: CanvasRenderingContext2D, f: FrameData, theme: GraphTheme, pos: Float32Array, x0: number, y0: number, x1: number, y1: number): void {
  let seeds = 0;
  for (let i = 0; i < f.n; i++) if (f.seedSlot[i]! >= 0) seeds++;
  const reach = Math.max(220, anchorRadius(seeds, f.n) * 1.15);
  for (let i = 0; i < f.n; i++) {
    const slot = f.seedSlot[i]!;
    if (slot < 0) continue;
    const color = hexAlpha(theme.seeds[slot % theme.seeds.length]!, WASH_ALPHA);
    if (!color) continue;
    const x = pos[2 * i]!;
    const y = pos[2 * i + 1]!;
    if (x + reach < x0 || x - reach > x1 || y + reach < y0 || y - reach > y1) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, reach);
    g.addColorStop(0, color);
    g.addColorStop(1, hexAlpha(theme.seeds[slot % theme.seeds.length]!, 0)!);
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

function popcount(v: number): number {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Seed-based node colouring (confluence and timeline): papers linked to one seed fill in that
 * seed's hue; papers linked to several become a neutral disc with one ring segment per linked
 * seed, each segment aimed at that seed's current position (a positional secondary encoding on
 * top of hue); seeds render as a hue donut with a background core; unlinked papers stay in the
 * muted isolated colour.
 */
function drawSeedColouredNodes(
  ctx: CanvasRenderingContext2D,
  f: FrameData,
  theme: GraphTheme,
  pos: Float32Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  k: number,
  visible: (i: number) => boolean,
  dim: boolean,
  focus: number,
  neighbors: Set<number> | null,
): void {
  // world position of each seed slot, for aiming ring segments
  const slotX = new Float32Array(32);
  const slotY = new Float32Array(32);
  let usedSlots = 0;
  for (let i = 0; i < f.n; i++) {
    const slot = f.seedSlot[i]!;
    if (slot >= 0 && slot < 32) {
      slotX[slot] = pos[2 * i]!;
      slotY[slot] = pos[2 * i + 1]!;
      if (slot + 1 > usedSlots) usedSlots = slot + 1;
    }
  }
  const hue = (slot: number) => theme.seeds[slot % theme.seeds.length]!;
  for (let pass = 0; pass < 2; pass++) {
    // pass 0: dimmed nodes, pass 1: normal/highlighted (drawn on top)
    ctx.globalAlpha = pass === 0 ? 0.25 : 1;
    const wanted = (i: number): boolean => {
      if (!visible(i)) return false;
      const isDim = dim && i !== focus && !(neighbors && neighbors.has(i));
      return (pass === 0) === isDim;
    };
    const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    // Direction shape (restores the reference/citation distinction without spending colour):
    // filled = reference (a paper in the map cites it), outlined = citation (it cites a paper
    // in the map), filled + detached ring = both. Isolated papers render filled.
    const hollowLw = 1.7 / k;
    const shapeOf = (i: number): 0 | 1 | 2 => (f.role[i] === NodeRole.Citing ? 1 : f.role[i] === NodeRole.Both ? 2 : 0);

    // single-seed papers (and seedless ones in the muted colour), batched per slot × shape
    const drawStyled = (color: string, member: (i: number) => boolean) => {
      const path = (shape: 0 | 1 | 2, inset: number): boolean => {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < f.n; i++) {
          if (f.seedSlot[i]! >= 0 || !member(i) || shapeOf(i) !== shape || !wanted(i)) continue;
          const x = pos[2 * i]!;
          const y = pos[2 * i + 1]!;
          if (!inView(x, y)) continue;
          const r = Math.max(0.5 / k, f.r[i]! + inset);
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TWO_PI);
          any = true;
        }
        return any;
      };
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (path(0, 0)) ctx.fill(); // references: solid
      if (path(2, 0)) ctx.fill(); // both: solid…
      ctx.lineWidth = 1.2 / k;
      if (path(2, 2.2 / k)) ctx.stroke(); // …plus a detached ring
      // citations: outlined — stroked singly because the ring width shrinks with the node,
      // so the hole stays visible on the small (typically recent, low-citation) papers
      for (let i = 0; i < f.n; i++) {
        if (f.seedSlot[i]! >= 0 || !member(i) || shapeOf(i) !== 1 || !wanted(i)) continue;
        const x = pos[2 * i]!;
        const y = pos[2 * i + 1]!;
        if (!inView(x, y)) continue;
        const r = f.r[i]!;
        const lw = Math.min(hollowLw, Math.max(0.9 / k, r * 0.42));
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5 / k, r - lw / 2), 0, TWO_PI);
        ctx.stroke();
      }
    };
    for (let slot = 0; slot < usedSlots; slot++) drawStyled(hue(slot), (i) => f.seedMask[i] === (1 << slot) >>> 0);
    drawStyled(theme.node[4]!, (i) => f.seedMask[i] === 0);

    // bridges: neutral disc + one aimed ring segment per linked seed (few nodes — drawn singly)
    for (let i = 0; i < f.n; i++) {
      const mask = f.seedMask[i]!;
      if (f.seedSlot[i]! >= 0 || popcount(mask) < 2 || !wanted(i)) continue;
      const x = pos[2 * i]!;
      const y = pos[2 * i + 1]!;
      if (!inView(x, y)) continue;
      const r = f.r[i]!;
      const shape = shapeOf(i);
      ctx.fillStyle = theme.disc;
      ctx.strokeStyle = theme.disc;
      ctx.beginPath();
      if (shape === 1) {
        const lw = Math.min(hollowLw, Math.max(0.9 / k, r * 0.42));
        ctx.lineWidth = lw;
        ctx.arc(x, y, Math.max(0.5 / k, r - lw / 2), 0, TWO_PI);
        ctx.stroke();
      } else {
        ctx.arc(x, y, r, 0, TWO_PI);
        ctx.fill();
      }
      const bits = popcount(mask);
      const span = Math.PI * (0.3 + 0.55 / bits);
      const lw = Math.max(2.2 / k, r * 0.4);
      ctx.lineWidth = lw;
      for (let slot = 0; slot < usedSlots; slot++) {
        if (!(mask & (1 << slot))) continue;
        const th = Math.atan2(slotY[slot]! - y, slotX[slot]! - x);
        ctx.strokeStyle = hue(slot);
        ctx.beginPath();
        ctx.arc(x, y, r + lw / 2 + 0.6 / k, th - span / 2, th + span / 2);
        ctx.stroke();
      }
      if (shape === 2) {
        // both: detached neutral ring outside the seed arcs
        ctx.strokeStyle = theme.disc;
        ctx.lineWidth = 1.2 / k;
        ctx.beginPath();
        ctx.arc(x, y, r + lw + 1.8 / k, 0, TWO_PI);
        ctx.stroke();
      }
    }

    // seeds: hue donut with a background core
    for (let i = 0; i < f.n; i++) {
      const slot = f.seedSlot[i]!;
      if (slot < 0 || !wanted(i)) continue;
      const x = pos[2 * i]!;
      const y = pos[2 * i + 1]!;
      if (!inView(x, y)) continue;
      const r = f.r[i]!;
      ctx.fillStyle = hue(slot);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fill();
      ctx.fillStyle = theme.bg;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.6 / k, r * 0.3), 0, TWO_PI);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function ring(ctx: CanvasRenderingContext2D, pos: Float32Array, rr: Float32Array, i: number, color: string, lw: number, pad: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(pos[2 * i]!, pos[2 * i + 1]!, rr[i]! + pad, 0, TWO_PI);
  ctx.stroke();
}

function drawArrows(ctx: CanvasRenderingContext2D, f: FrameData, focus: number, color: string, k: number, visibleRoleMask: number): void {
  const pos = f.pos;
  const size = 6 / k;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < f.m; i++) {
    const a = f.edgeSrc[i]!;
    const b = f.edgeDst[i]!;
    if (!roleIsVisible(visibleRoleMask, f.role[a]!) || !roleIsVisible(visibleRoleMask, f.role[b]!)) continue;
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
