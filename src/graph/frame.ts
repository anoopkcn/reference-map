/** Mutable, typed-array view of the graph for the renderer and hit-testing (main thread). */
export interface FrameData {
  n: number;
  /** interleaved x,y */
  pos: Float32Array;
  r: Float32Array;
  role: Uint8Array;
  /** bit flags, see FLAG_* */
  flags: Uint8Array;
  labels: string[];
  titles: string[];
  ids: string[];
  m: number;
  edgeSrc: Int32Array;
  edgeDst: Int32Array;
  hovered: number;
  selected: number;
  /** incremented whenever structure (n, m, roles, flags) changes */
  version: number;
  alpha: number;
}

export const FLAG_SEED = 1;
export const FLAG_PINNED = 2;
export const FLAG_EXPANDED = 4;
export const FLAG_EXPANDING = 8;

/** All graph roles (Seed, Cited, Citing, Both, and the internal Isolated role). */
export const ALL_ROLE_MASK = 0b1_1111;

export function roleIsVisible(mask: number, role: number): boolean {
  return (mask & (1 << role)) !== 0;
}

export function createFrame(): FrameData {
  return {
    n: 0,
    pos: new Float32Array(0),
    r: new Float32Array(0),
    role: new Uint8Array(0),
    flags: new Uint8Array(0),
    labels: [],
    titles: [],
    ids: [],
    m: 0,
    edgeSrc: new Int32Array(0),
    edgeDst: new Int32Array(0),
    hovered: -1,
    selected: -1,
    version: 0,
    alpha: 0,
  };
}

function grow<T extends Float32Array | Uint8Array | Int32Array>(arr: T, need: number, make: (n: number) => T): T {
  if (arr.length >= need) return arr;
  const next = make(Math.max(need, arr.length * 2, 64));
  next.set(arr);
  return next;
}

export function ensureNodeCapacity(f: FrameData, n: number): void {
  f.pos = grow(f.pos, 2 * n, (k) => new Float32Array(k));
  f.r = grow(f.r, n, (k) => new Float32Array(k));
  f.role = grow(f.role, n, (k) => new Uint8Array(k));
  f.flags = grow(f.flags, n, (k) => new Uint8Array(k));
}

export function ensureEdgeCapacity(f: FrameData, m: number): void {
  f.edgeSrc = grow(f.edgeSrc, m, (k) => new Int32Array(k));
  f.edgeDst = grow(f.edgeDst, m, (k) => new Int32Array(k));
}
