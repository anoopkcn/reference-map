import { describe, expect, it } from 'vitest';
import { SimulationCore } from './simulationCore';

describe('SimulationCore', () => {
  it('adds nodes/links, ticks move nodes, alpha decays', () => {
    const c = new SimulationCore();
    c.addNodes([5, 5, 5], [0, 10, NaN], [0, 0, NaN]);
    c.addLinks([0, 1], [1, 2]);
    expect(c.count).toBe(3);
    expect(c.links.length).toBe(2);
    const before = c.nodes.map((n) => [n.x, n.y]);
    const a0 = c.alpha;
    c.tick();
    expect(c.alpha).toBeLessThan(a0);
    const after = c.nodes.map((n) => [n.x, n.y]);
    expect(after).not.toEqual(before);
    const buf = new Float32Array(6);
    c.writePositions(buf);
    expect(buf[0]).toBeCloseTo(c.nodes[0]!.x);
    expect(buf[5]).toBeCloseTo(c.nodes[2]!.y);
  });

  it('drag pins a node; dragEnd(pin=false) releases; pin/unpin', () => {
    const c = new SimulationCore();
    c.addNodes([4, 4], [0, 30], [0, 0]);
    c.addLinks([0], [1]);
    c.drag(0, 100, 100);
    for (let i = 0; i < 5; i++) c.tick();
    expect(c.nodes[0]!.x).toBe(100);
    expect(c.nodes[0]!.y).toBe(100);
    c.dragEnd(0, true);
    c.tick();
    expect(c.nodes[0]!.x).toBe(100);
    c.unpin(0);
    for (let i = 0; i < 5; i++) c.tick();
    expect(c.nodes[0]!.x).not.toBe(100);
    c.pin(1, -5, -5);
    c.tick();
    expect(c.nodes[1]!.x).toBe(-5);
    c.unpinAll();
    expect(c.nodes[1]!.fx).toBeNull();
  });

  it('reset replaces nodes and keeps pinned flags; reheat raises alpha', () => {
    const c = new SimulationCore();
    c.addNodes([1, 1, 1], [0, 1, 2], [0, 0, 0]);
    for (let i = 0; i < 300; i++) c.tick();
    expect(c.alpha).toBeLessThan(0.01);
    c.reset([2, 2], [5, 6], [5, 6], [1, 0], [0], [1]);
    expect(c.count).toBe(2);
    expect(c.links.length).toBe(1);
    expect(c.nodes[0]!.fx).toBe(5);
    expect(c.nodes[1]!.fx).toBeUndefined();
    c.reheat(0.6);
    expect(c.alpha).toBeCloseTo(0.6);
    c.setRadii([9, 9]);
    expect(c.nodes[1]!.r).toBe(9);
  });
});
