import { ALL_ROLE_MASK, roleIsVisible, type FrameData } from './frame';
import type { ViewTransform } from './renderer';

/** Nearest node under screen point (sx, sy) with a small slack; -1 if none. Linear scan — fast enough for thousands of nodes. */
export function hitTestNode(f: FrameData, view: ViewTransform, sx: number, sy: number, visibleRoleMask = ALL_ROLE_MASK): number {
  const gx = (sx - view.x) / view.k;
  const gy = (sy - view.y) / view.k;
  const slack = 4 / view.k;
  let best = -1;
  let bestD = Infinity;
  const pos = f.pos;
  for (let i = 0; i < f.n; i++) {
    if (!roleIsVisible(visibleRoleMask, f.role[i]!)) continue;
    const dx = pos[2 * i]! - gx;
    const dy = pos[2 * i + 1]! - gy;
    const rr = f.r[i]! + slack;
    const d2 = dx * dx + dy * dy;
    if (d2 <= rr * rr && d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function frameBBox(f: FrameData, visibleRoleMask = ALL_ROLE_MASK): BBox | null {
  if (f.n === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < f.n; i++) {
    if (!roleIsVisible(visibleRoleMask, f.role[i]!)) continue;
    const x = f.pos[2 * i]!;
    const y = f.pos[2 * i + 1]!;
    const r = f.r[i]!;
    if (x - r < minX) minX = x - r;
    if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r;
    if (y + r > maxY) maxY = y + r;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Transform that fits the bbox into width×height with padding. */
export function fitTransform(b: BBox, width: number, height: number, padding = 48, maxK = 2): ViewTransform {
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const k = Math.min(maxK, Math.max(0.05, Math.min((width - 2 * padding) / w, (height - 2 * padding) / h)));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}
