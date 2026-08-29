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

  it('timeline mode converges to targets and picks up retargeting', () => {
    const c = new SimulationCore();
    c.addNodes([5, 5, 5], [0, 0, 0], [0, 0, 0]);
    c.setTargets([-100, 0, 100], [-50, 0, 50]);
    c.setMode('timeline');
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    expect(Math.abs(c.nodes[0]!.x - -100)).toBeLessThan(2);
    expect(Math.abs(c.nodes[0]!.y - -50)).toBeLessThan(2);
    expect(Math.abs(c.nodes[2]!.x - 100)).toBeLessThan(2);
    expect(Math.abs(c.nodes[2]!.y - 50)).toBeLessThan(2);
    // retarget after convergence: guards d3's accessor-cache-at-initialize pitfall
    c.setTargets([100, 0, -100], [50, 0, -50]);
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    expect(Math.abs(c.nodes[0]!.x - 100)).toBeLessThan(2);
    expect(Math.abs(c.nodes[2]!.y - -50)).toBeLessThan(2);
  });

  it('confluence mode is target-driven like timeline (links detached, retargeting works)', () => {
    const c = new SimulationCore();
    c.addNodes([5, 5], [0, 0], [0, 0]);
    c.addLinks([0], [1]);
    c.setMode('confluence');
    c.setTargets([-120, 120], [40, -40]);
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    // the link would hold them ~linkDistance apart if it were still attached
    expect(Math.abs(c.nodes[0]!.x - -120)).toBeLessThan(2);
    expect(Math.abs(c.nodes[1]!.x - 120)).toBeLessThan(2);
    c.setTargets([0, 0], [0, 0]);
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    expect(Math.abs(c.nodes[0]!.x)).toBeLessThan(20); // only collide separates them now
  });

  it('NaN target falls back to centering on that axis only', () => {
    const c = new SimulationCore();
    c.addNodes([5], [200], [200]);
    c.setTargets([NaN], [80]);
    c.setMode('timeline');
    c.reheat(1);
    for (let i = 0; i < 400; i++) c.tick();
    expect(Math.abs(c.nodes[0]!.y - 80)).toBeLessThan(2);
    expect(Math.abs(c.nodes[0]!.x)).toBeLessThan(100); // weak centering pulls toward 0
  });

  it('detaches link/charge in timeline and restores them in force mode', () => {
    const c = new SimulationCore();
    c.addNodes([5, 5], [-10, 10], [0, 0]);
    c.addLinks([0], [1]);
    c.setMode('timeline');
    c.setTargets([0, 0], [0, 0]);
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    // identical targets: only collide separates them, so they sit close, not at link distance
    const dTimeline = Math.hypot(c.nodes[0]!.x - c.nodes[1]!.x, c.nodes[0]!.y - c.nodes[1]!.y);
    expect(dTimeline).toBeLessThan(30);
    c.setMode('force');
    c.reheat(1);
    for (let i = 0; i < 300; i++) c.tick();
    const dForce = Math.hypot(c.nodes[0]!.x - c.nodes[1]!.x, c.nodes[0]!.y - c.nodes[1]!.y);
    expect(dForce).toBeGreaterThan(dTimeline);
  });

  it('reset clears targets; short target arrays clamp without throwing', () => {
    const c = new SimulationCore();
    c.setMode('timeline');
    c.addNodes([5, 5], [0, 0], [0, 0]);
    c.setTargets([10, 20], [10, 20]);
    c.reset([5, 5, 5], [0, 1, 2], [0, 0, 0], [0, 0, 0], [], []);
    expect(c.nodes.every((n) => n.tx === undefined)).toBe(true);
    c.setTargets([50], [50]); // shorter than count: rest become NaN (no target)
    expect(c.nodes[0]!.tx).toBe(50);
    expect(c.nodes[1]!.tx).toBeNaN();
    for (let i = 0; i < 10; i++) c.tick();
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
