import { useEffect, useState } from 'react';
import { useAppStore } from '../store';

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Resolved theme ('light' | 'dark') for the current setting and OS preference. */
export function useTheme(): 'light' | 'dark' {
  const theme = useAppStore((s) => s.settings.theme);
  const [systemDark, setSystemDark] = useState(() => !!mq?.matches);
  useEffect(() => {
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // The data-theme attribute itself is applied by the store (see store/index.ts) so it is in place
  // before any child effect reads CSS variables.
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}
