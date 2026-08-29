/** Messages between the main thread and the layout worker. Node identity is the integer index. */

import type { LayoutMode } from '../types';

export interface SimParams {
  linkDistance: number;
  charge: number;
  chargeDistanceMax: number;
  collidePadding: number;
  centerStrength: number;
  /** forceX/Y strength toward layout targets (timeline, confluence); collide is alpha-independent so it still wins locally. */
  timelineStrength: number;
  alphaDecay: number;
  velocityDecay: number;
  alphaMin: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  linkDistance: 40,
  charge: -110,
  chargeDistanceMax: 800,
  collidePadding: 2,
  centerStrength: 0.03,
  timelineStrength: 0.6,
  alphaDecay: 0.028,
  velocityDecay: 0.4,
  alphaMin: 0.001,
};

export type MainToWorker =
  | { t: 'init'; params?: Partial<SimParams> }
  /** Append nodes; idx continues from the current count. Positions may be NaN (→ random near origin). */
  | { t: 'addNodes'; r: Float32Array; x: Float32Array; y: Float32Array }
  | { t: 'addLinks'; src: Int32Array; dst: Int32Array }
  | { t: 'setRadii'; r: Float32Array }
  /** Replace everything (after a rebuild). */
  | { t: 'reset'; r: Float32Array; x: Float32Array; y: Float32Array; pinned: Uint8Array; src: Int32Array; dst: Int32Array }
  | { t: 'drag'; idx: number; x: number; y: number }
  | { t: 'dragEnd'; idx: number; pin: boolean }
  | { t: 'pin'; idx: number; x: number; y: number }
  | { t: 'unpin'; idx: number }
  | { t: 'unpinAll' }
  | { t: 'mode'; mode: LayoutMode }
  /** Per-index world targets, NaN = no target (centering fallback). Transferred; freshly
   *  allocated each send (per structural sync, not per tick — no pooling/return path). */
  | { t: 'targets'; x: Float32Array; y: Float32Array }
  | { t: 'reheat'; alpha: number }
  | { t: 'stop' }
  /** Return a position buffer so the worker can reuse it. */
  | { t: 'buffer'; pos: Float32Array };

export type WorkerToMain =
  | { t: 'ready' }
  /** Interleaved x,y for the first n nodes. Transferred — send it back with `buffer`. */
  | { t: 'tick'; pos: Float32Array; n: number; alpha: number }
  | { t: 'end' };
