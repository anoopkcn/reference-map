/**
 * Timeline-layout geometry: the single source of truth for mapping publication year → world x
 * and citation count → world y. Shared by the bridge (worker targets) and the renderer (axes),
 * so axis gridlines pass exactly through the nodes they describe.
 */

/** World px per publication year. */
export const PX_PER_YEAR = 60;
/** World px per decade of citations (log10 scale). */
export const Y_PER_LOG10 = 90;

export interface YearDomain {
  min: number;
  max: number;
}

/** Min/max over year[i] for i < n, ignoring unknown years (<= 0). null when none are known. */
export function yearDomain(year: ArrayLike<number>, n: number): YearDomain | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const yr = year[i]!;
    if (yr <= 0) continue;
    if (yr < min) min = yr;
    if (yr > max) max = yr;
  }
  return max >= min ? { min, max } : null;
}

/** The domain midpoint maps to x = 0 so the layout stays centered on the world origin. */
export function yearToX(year: number, d: YearDomain): number {
  return (year - (d.min + d.max) / 2) * PX_PER_YEAR;
}

/** Screen y grows downward, so more-cited papers sit higher. 0 citations => y = 0 (baseline). */
export function citationsToY(count: number): number {
  return -Math.log10(count + 1) * Y_PER_LOG10;
}

const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/** Smallest year-tick step whose on-screen spacing at zoom k is >= minLabelPx. */
export function yearTickStep(k: number, minLabelPx = 60): number {
  for (const step of YEAR_STEPS) {
    if (step * PX_PER_YEAR * k >= minLabelPx) return step;
  }
  return YEAR_STEPS[YEAR_STEPS.length - 1]!;
}

/** Decades per citation gridline so on-screen spacing at zoom k is >= minLabelPx. */
export function citationTickStep(k: number, minLabelPx = 40): number {
  return Math.max(1, Math.ceil(minLabelPx / (Y_PER_LOG10 * k)));
}

/** Compact citation-count tick label: 1, 10, 100, 1k, 10k, 100k, 1M, ... */
export function formatCount(c: number): string {
  if (c >= 1e9) return `${c / 1e9}B`;
  if (c >= 1e6) return `${c / 1e6}M`;
  if (c >= 1e3) return `${c / 1e3}k`;
  return String(c);
}
