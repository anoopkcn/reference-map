import { describe, expect, it } from 'vitest';
import { citationTickStep, citationsToY, formatCount, PX_PER_YEAR, Y_PER_LOG10, yearDomain, yearTickStep, yearToX } from './timeline';

describe('yearDomain', () => {
  it('returns null when no years are known', () => {
    expect(yearDomain([], 0)).toBeNull();
    expect(yearDomain([0, 0, -1], 3)).toBeNull();
  });

  it('ignores unknown years and values beyond n', () => {
    expect(yearDomain([0, 1999, 2020, 2050], 3)).toEqual({ min: 1999, max: 2020 });
  });

  it('handles a single known year (min === max)', () => {
    expect(yearDomain([0, 2015], 2)).toEqual({ min: 2015, max: 2015 });
  });
});

describe('yearToX', () => {
  const d = { min: 2000, max: 2020 };
  it('maps the domain midpoint to 0', () => {
    expect(yearToX(2010, d)).toBe(0);
  });
  it('spaces years by PX_PER_YEAR, symmetric around the midpoint', () => {
    expect(yearToX(2011, d) - yearToX(2010, d)).toBe(PX_PER_YEAR);
    expect(yearToX(2000, d)).toBe(-yearToX(2020, d));
  });
});

describe('citationsToY', () => {
  it('puts 0 citations at the baseline', () => {
    expect(citationsToY(0)).toBeCloseTo(0, 10);
  });
  it('is strictly decreasing (more citations sit higher)', () => {
    expect(citationsToY(10)).toBeLessThan(citationsToY(0));
    expect(citationsToY(1000)).toBeLessThan(citationsToY(10));
  });
  it('spaces decades by about Y_PER_LOG10', () => {
    expect(citationsToY(999) - citationsToY(9999)).toBeCloseTo(Y_PER_LOG10, 5);
  });
});

describe('tick steps', () => {
  it('yearTickStep picks 1 at k=1 and widens as you zoom out', () => {
    expect(yearTickStep(1)).toBe(1);
    const zoomedOut = yearTickStep(0.05);
    expect(zoomedOut).toBeGreaterThan(1);
    expect(zoomedOut * PX_PER_YEAR * 0.05).toBeGreaterThanOrEqual(60);
  });
  it('citationTickStep is 1 decade at k=1 and grows when zoomed out', () => {
    expect(citationTickStep(1)).toBe(1);
    expect(citationTickStep(0.1)).toBeGreaterThan(1);
  });
});

describe('formatCount', () => {
  it('formats decade ticks compactly', () => {
    expect(formatCount(1)).toBe('1');
    expect(formatCount(100)).toBe('100');
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(10000)).toBe('10k');
    expect(formatCount(1000000)).toBe('1M');
  });
});
