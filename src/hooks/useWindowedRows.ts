import { useEffect, useState, type RefObject } from 'react';

export interface Window {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** Fixed-height row windowing for a scroll container. Returns the visible index range and spacer heights. */
export function useWindowedRows(ref: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan = 8): Window {
  const [range, setRange] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = el.scrollTop;
      const height = el.clientHeight;
      setRange((r) => (r.top === top && r.height === height ? r : { top, height }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
  const start = Math.max(0, Math.floor(range.top / rowHeight) - overscan);
  const visible = Math.ceil((range.height || 600) / rowHeight) + overscan * 2;
  const end = Math.min(count, start + visible);
  return { start, end, padTop: start * rowHeight, padBottom: Math.max(0, (count - end) * rowHeight) };
}
