import { describe, expect, it } from 'vitest';
import { createFrame } from './frame';
import { frameBBox, hitTestNode } from './hitTest';

describe('graph role visibility', () => {
  const frame = () => {
    const f = createFrame();
    f.n = 2;
    f.pos = new Float32Array([10, 10, 100, 100]);
    f.r = new Float32Array([5, 10]);
    f.role = new Uint8Array([0, 1]);
    return f;
  };

  it('does not hit a node whose role is hidden', () => {
    const f = frame();
    const view = { k: 1, x: 0, y: 0 };
    expect(hitTestNode(f, view, 10, 10)).toBe(0);
    expect(hitTestNode(f, view, 10, 10, 1 << 1)).toBe(-1);
    expect(hitTestNode(f, view, 100, 100, 1 << 1)).toBe(1);
  });

  it('fits only the roles currently shown', () => {
    const f = frame();
    expect(frameBBox(f)).toEqual({ minX: 5, minY: 5, maxX: 110, maxY: 110 });
    expect(frameBBox(f, 1 << 0)).toEqual({ minX: 5, minY: 5, maxX: 15, maxY: 15 });
    expect(frameBBox(f, 0)).toBeNull();
  });
});
