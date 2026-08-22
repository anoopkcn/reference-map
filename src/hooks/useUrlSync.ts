import { useEffect } from 'react';
import { debounce } from '../lib/debounce';
import { readUrlState, writeUrlState } from '../lib/url-state';
import { appStore } from '../store';

/** Seeds (and selection) ↔ `?ids=…&sel=…`. Reads once on mount, writes (debounced) on change. */
export function useUrlSync(): void {
  useEffect(() => {
    const initial = readUrlState();
    const sel = initial.sel;
    if (initial.lookups.length) {
      void appStore
        .getState()
        .addSeeds(initial.lookups)
        .then(() => {
          if (sel) void appStore.getState().selectByKey(sel);
        });
    } else if (sel) void appStore.getState().selectByKey(sel);

    const write = debounce(() => {
      const s = appStore.getState();
      writeUrlState({ lookups: s.seeds.map((x) => x.lookup), sel: s.selectedId });
    }, 250);
    const unsub = appStore.subscribe((s, prev) => {
      if (s.seeds !== prev.seeds || s.selectedId !== prev.selectedId) write();
    });
    const onPop = () => {
      const st = readUrlState();
      const have = new Set(appStore.getState().seeds.map((x) => x.lookup.toLowerCase()));
      const missing = st.lookups.filter((l) => !have.has(l.toLowerCase()));
      if (missing.length) void appStore.getState().addSeeds(missing);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      unsub();
      write.cancel();
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
