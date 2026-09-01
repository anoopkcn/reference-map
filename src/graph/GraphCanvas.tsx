import { pointer, select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { appStore, useAppStore } from '../store';
import { GraphBridge } from './bridge';
import { createFrame, roleIsVisible } from './frame';
import { fitTransform, frameBBox, hitTestNode } from './hitTest';
import { drawFrame, readTheme, type GraphTheme, type ViewTransform } from './renderer';
import { GraphTooltip } from './GraphTooltip';

export interface GraphControls {
  fit(): void;
  reheat(): void;
  unpinAll(): void;
}

const DBLCLICK_MS = 350;
const DRAG_THRESHOLD = 3;

/** Canvas renderer: positions from the worker bridge, zoom/pan via d3-zoom, pointer interactions in world space. */
export function GraphCanvas({
  controlsRef,
  themeKey,
  visibleRoleMask,
  bottomInset = 0,
}: {
  controlsRef: RefObject<GraphControls | null>;
  themeKey: string;
  visibleRoleMask: number;
  /** Screen px along the bottom edge covered by overlays (the legend) — axis labels move above it. */
  bottomInset?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(createFrame());
  const bridgeRef = useRef<GraphBridge | null>(null);
  const viewRef = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const themeRef = useRef<GraphTheme | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const activeRef = useRef(true);
  const rafRef = useRef(0);
  const focusRef = useRef<{ focus: number; neighbors: Set<number> | null; version: number; gv: number }>({ focus: -1, neighbors: null, version: -1, gv: -1 });
  const userInteracted = useRef(false);
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const animRef = useRef(0);
  const labelMode = useAppStore((s) => s.settings.labelMode);
  const labelModeRef = useRef(labelMode);
  const layoutMode = useAppStore((s) => s.settings.layoutMode);
  const layoutModeRef = useRef(layoutMode);
  // While true, the camera re-fits on every tick so a mode transition stays in frame
  // instead of waiting seconds for the sim to settle. Cleared on the next 'end'.
  const followLayoutRef = useRef(false);
  const layoutModeMounted = useRef(false);
  const visibleRoleMaskRef = useRef(visibleRoleMask);
  const bottomInsetRef = useRef(bottomInset);
  const [tipIdx, setTipIdx] = useState(-1);
  const tipIdxRef = useRef(-1);

  // ---- drawing ----
  const draw = () => {
    rafRef.current = 0;
    if (!activeRef.current) return;
    const canvas = canvasRef.current;
    const theme = themeRef.current;
    if (!canvas || !theme) return;
    bridgeRef.current?.consumeTick();
    const ctx = ctxRef.current;
    if (!ctx) return;
    const f = frameRef.current;
    const { w, h, dpr } = sizeRef.current;
    // focus + neighbour cache
    const fc = focusRef.current;
    const focus = f.hovered >= 0 ? f.hovered : f.selected;
    const s = appStore.getState();
    if (fc.focus !== focus || fc.gv !== s.graph.version) {
      fc.focus = focus;
      fc.gv = s.graph.version;
      if (focus >= 0) {
        const id = f.ids[focus];
        const nb = id ? s.graph.neighbors(id) : null;
        const set = new Set<number>();
        if (nb) for (const n of nb) {
          const idx = s.graph.getNode(n)?.idx;
          if (idx !== undefined) set.add(idx);
        }
        fc.neighbors = set;
      } else fc.neighbors = null;
    }
    drawFrame(ctx, f, viewRef.current, theme, { width: w, height: h, dpr, labelMode: labelModeRef.current, layoutMode: layoutModeRef.current, neighbors: fc.neighbors, focus, tooltipIdx: tipIdxRef.current, visibleRoleMask: visibleRoleMaskRef.current, bottomInset: bottomInsetRef.current });
  };
  const markDirty = () => {
    if (activeRef.current && !rafRef.current) rafRef.current = requestAnimationFrame(draw);
  };

  useEffect(() => {
    labelModeRef.current = labelMode;
    markDirty();
  }, [labelMode]);

  useEffect(() => {
    bottomInsetRef.current = bottomInset;
    markDirty();
  }, [bottomInset]);

  useEffect(() => {
    layoutModeRef.current = layoutMode;
    if (!layoutModeMounted.current) {
      layoutModeMounted.current = true;
      return;
    }
    // Re-enable auto-fit and track the transition: nodes fly to the new layout over a few
    // seconds, so the camera follows each tick rather than waiting for the settle.
    userInteracted.current = false;
    followLayoutRef.current = true;
    markDirty();
  }, [layoutMode]);

  useEffect(() => {
    visibleRoleMaskRef.current = visibleRoleMask;
    const idx = tipIdxRef.current;
    if (idx >= 0 && !roleIsVisible(visibleRoleMask, frameRef.current.role[idx]!)) {
      tipIdxRef.current = -1;
      setTipIdx(-1);
      appStore.getState().hover(null);
    }
    markDirty();
  }, [visibleRoleMask]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) themeRef.current = readTheme(el);
    markDirty();
  }, [themeKey]);

  // ---- mount: bridge, sizing, zoom, pointer handlers ----
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    activeRef.current = true;
    ctxRef.current = canvas.getContext('2d');
    if (!ctxRef.current) return;
    themeRef.current = readTheme(container);
    const frame = frameRef.current;
    let hadNodes = frame.n > 0;
    let seedFitPending = false;
    let seedFitRaf = 0;

    const applyTransform = (t: ViewTransform, animate: boolean) => {
      const z = zoomRef.current;
      if (!z) return;
      cancelAnimationFrame(animRef.current);
      const sel = select(canvas);
      if (!animate) {
        sel.call(z.transform, zoomIdentity.translate(t.x, t.y).scale(t.k));
        return;
      }
      const from = { ...viewRef.current };
      const t0 = performance.now();
      const dur = 380;
      const step = (now: number) => {
        const u = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - u, 3);
        // interpolate in log-space for scale
        const k = Math.exp(Math.log(from.k) + (Math.log(t.k) - Math.log(from.k)) * e);
        const x = from.x + (t.x - from.x) * e;
        const y = from.y + (t.y - from.y) * e;
        sel.call(z.transform, zoomIdentity.translate(x, y).scale(k));
        if (u < 1) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    };

    const fit = (animate = true) => {
      const b = frameBBox(frame, visibleRoleMaskRef.current);
      const { w, h } = sizeRef.current;
      if (!b || !w || !h) return;
      applyTransform(fitTransform(b, w, h), animate);
    };

    const bridge = new GraphBridge(
      appStore,
      frame,
      {
        onTick: () => {
          if (followLayoutRef.current && !userInteracted.current) fit(false);
          markDirty();
        },
        onStructure: () => {
          if (!hadNodes && frame.n > 0) {
            hadNodes = true;
            fit(false);
          }
          if (frame.n === 0) hadNodes = false;
          markDirty();
        },
        onEnd: () => {
          followLayoutRef.current = false;
          markDirty();
          if (!userInteracted.current) fit(true);
        },
      },
    );
    bridgeRef.current = bridge;

    // Seed membership changes are navigation-level graph changes: frame the new map immediately.
    // Resetting userInteracted also lets the settled layout receive the existing final auto-fit.
    let seedKey = readySeedKey(appStore.getState().seeds);
    const unsubscribeSeeds = appStore.subscribe((state) => {
      const nextKey = readySeedKey(state.seeds);
      if (nextKey === seedKey) return;
      seedKey = nextKey;
      userInteracted.current = false;
      seedFitPending = true;
      cancelAnimationFrame(seedFitRaf);
      seedFitRaf = requestAnimationFrame(() => {
        seedFitRaf = 0;
        if (!activeRef.current) return;
        seedFitPending = false;
        fit(true);
      });
    });

    // sizing
    const resize = () => {
      const rect = container.getBoundingClientRect();
      rectRef.current = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const first = sizeRef.current.w === 0;
      const prev = sizeRef.current;
      sizeRef.current = { w, h, dpr };
      if (prev.w !== w || prev.h !== h || prev.dpr !== dpr) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      if (first) {
        viewRef.current = { k: 1, x: w / 2, y: h / 2 };
        if (zoomRef.current) select(canvas).call(zoomRef.current.transform, zoomIdentity.translate(w / 2, h / 2));
        if (frame.n > 0) fit(false);
      } else if (zoomRef.current && (prev.w !== w || prev.h !== h)) {
        if (!userInteracted.current && frame.n > 0) {
          // still on the automatic framing: re-fit to the new stage size (e.g. when the details column opens)
          fit(false);
        } else {
          // keep the world point at the viewport centre fixed
          const v = viewRef.current;
          select(canvas).call(zoomRef.current.translateBy, (w - prev.w) / 2 / v.k, (h - prev.h) / 2 / v.k);
        }
      }
      markDirty();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // CSS tabs, page visibility and offscreen placement all pause worker and canvas work.
    let intersecting = true;
    const updateActive = () => {
      const active = intersecting && !document.hidden;
      if (activeRef.current === active) return;
      activeRef.current = active;
      bridge.setActive(active);
      if (active) {
        resize();
        if (seedFitPending) {
          seedFitPending = false;
          fit(true);
        } else markDirty();
      } else {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
    const io = new IntersectionObserver((entries) => {
      intersecting = entries[0]?.isIntersecting ?? false;
      updateActive();
    });
    io.observe(container);
    document.addEventListener('visibilitychange', updateActive);
    const refreshRect = () => {
      rectRef.current = canvas.getBoundingClientRect();
    };
    window.addEventListener('scroll', refreshRect, { passive: true, capture: true });

    // zoom/pan
    const zoom = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 8])
      .filter((ev: MouseEvent | TouchEvent | WheelEvent) => {
        if ((ev as MouseEvent).button) return false;
        if (ev.type === 'mousedown' || ev.type === 'touchstart') {
          const src = ev.type === 'touchstart' ? (ev as TouchEvent).touches[0] : ev;
          if (!src) return true;
          const [px, py] = pointer(src, canvas);
          return hitTestNode(frame, viewRef.current, px, py, visibleRoleMaskRef.current) < 0;
        }
        return true;
      })
      .on('zoom', (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        viewRef.current = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
        if (ev.sourceEvent) userInteracted.current = true;
        markDirty();
      });
    zoomRef.current = zoom;
    const sel = select(canvas);
    sel.call(zoom).on('dblclick.zoom', null);
    resize();

    // pointer interactions
    let dragging = -1;
    let downPt: [number, number] | null = null;
    let moved = false;
    let downHit = -1;
    let lastClick = { idx: -1, t: 0 };
    let pendingSelect = 0;
    let hoverRaf = 0;
    let hoverPt: [number, number] | null = null;

    const toWorld = (sx: number, sy: number): [number, number] => {
      const v = viewRef.current;
      return [(sx - v.x) / v.k, (sy - v.y) / v.k];
    };
    const localPoint = (e: PointerEvent): [number, number] => {
      const r = rectRef.current ?? canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const setHover = (idx: number, sx: number, sy: number) => {
      const id = idx >= 0 ? frame.ids[idx] ?? null : null;
      appStore.getState().hover(id);
      if (tipIdxRef.current !== idx) {
        tipIdxRef.current = idx;
        markDirty();
      }
      setTipIdx(idx);
      const tip = tipRef.current;
      if (tip) {
        tip.style.transform = `translate(${Math.round(sx + 14)}px, ${Math.round(sy + 14)}px)`;
      }
      canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
    };
    const runHover = () => {
      hoverRaf = 0;
      if (!hoverPt) return;
      const [sx, sy] = hoverPt;
      setHover(hitTestNode(frame, viewRef.current, sx, sy, visibleRoleMaskRef.current), sx, sy);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const [sx, sy] = localPoint(e);
      downPt = [sx, sy];
      moved = false;
      downHit = hitTestNode(frame, viewRef.current, sx, sy, visibleRoleMaskRef.current);
      if (downHit >= 0) {
        dragging = downHit;
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      const [sx, sy] = localPoint(e);
      if (dragging >= 0 && downPt) {
        if (!moved && Math.hypot(sx - downPt[0], sy - downPt[1]) > DRAG_THRESHOLD) moved = true;
        if (moved) {
          const [wx, wy] = toWorld(sx, sy);
          bridge.drag(dragging, wx, wy);
          userInteracted.current = true;
          const tip = tipRef.current;
          if (tip) tip.style.transform = `translate(${Math.round(sx + 14)}px, ${Math.round(sy + 14)}px)`;
          markDirty();
        }
        return;
      }
      if (downPt && !moved && Math.hypot(sx - downPt[0], sy - downPt[1]) > DRAG_THRESHOLD) moved = true;
      hoverPt = [sx, sy];
      if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
    };
    const onPointerUp = (e: PointerEvent) => {
      const [sx, sy] = localPoint(e);
      if (dragging >= 0) {
        const idx = dragging;
        dragging = -1;
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (moved) {
          // Timeline positions encode data (year × citations) — released nodes spring back
          // instead of pinning. Pins made in force mode persist across the switch (unpin to release).
          bridge.dragEnd(idx, layoutModeRef.current === 'force');
        } else {
          // A plain click selects, but only after the double-click window passes —
          // a double-click expands the node without opening the details panel.
          // Layout worker is left alone so pinned nodes stay pinned.
          const id = frame.ids[idx];
          const now = performance.now();
          if (id) {
            clearTimeout(pendingSelect);
            if (lastClick.idx === idx && now - lastClick.t < DBLCLICK_MS) {
              void appStore.getState().expandNode(id);
              lastClick = { idx: -1, t: 0 };
            } else {
              pendingSelect = window.setTimeout(() => appStore.getState().select(id), DBLCLICK_MS);
              lastClick = { idx, t: now };
            }
          }
        }
        canvas.style.cursor = 'pointer';
      }
      // Clicking empty space intentionally does nothing (the details panel stays open; use its × or Esc).
      downPt = null;
      hoverPt = [sx, sy];
      if (!hoverRaf) hoverRaf = requestAnimationFrame(runHover);
    };
    const onPointerLeave = () => {
      hoverPt = null;
      if (dragging < 0) setHover(-1, 0, 0);
    };

    const onDblClick = (e: MouseEvent) => {
      const r = rectRef.current ?? canvas.getBoundingClientRect();
      const idx = hitTestNode(frame, viewRef.current, e.clientX - r.left, e.clientY - r.top, visibleRoleMaskRef.current);
      const id = idx >= 0 ? frame.ids[idx] : undefined;
      if (!id) return;
      e.preventDefault();
      clearTimeout(pendingSelect);
      void appStore.getState().expandNode(id);
      lastClick = { idx: -1, t: 0 };
    };
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.style.cursor = 'grab';

    controlsRef.current = {
      fit: () => fit(true),
      reheat: () => bridge.reheat(0.7),
      unpinAll: () => bridge.unpinAll(),
    };

    return () => {
      controlsRef.current = null;
      unsubscribeSeeds();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', updateActive);
      window.removeEventListener('scroll', refreshRect, true);
      sel.on('.zoom', null);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      clearTimeout(pendingSelect);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      cancelAnimationFrame(animRef.current);
      animRef.current = 0;
      cancelAnimationFrame(seedFitRaf);
      seedFitRaf = 0;
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
      bridge.destroy();
      bridgeRef.current = null;
      ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tipId = tipIdx >= 0 ? frameRef.current.ids[tipIdx] ?? null : null;

  return (
    <div className="graph-canvas-wrap" ref={containerRef}>
      <canvas ref={canvasRef} className="graph-canvas" aria-label="Reference map" role="img" />
      <GraphTooltip ref={tipRef} id={tipId} />
    </div>
  );
}

function readySeedKey(seeds: readonly { paperId: string | null; status: string }[]): string {
  return seeds.filter((seed) => seed.status === 'ready' && seed.paperId).map((seed) => seed.paperId).join('\0');
}
