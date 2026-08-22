import { MemoryCache } from '../api/cache';
import { RequestQueue } from '../api/queue';
import { S2Client } from '../api/s2';
import { loadSettings } from './settings';
import { createAppStore } from './store';

export const queue = new RequestQueue();
export const appStore = createAppStore({
  queue,
  client: new S2Client({ queue, getApiKey: () => appStore.getState().settings.apiKey }),
  cache: new MemoryCache(),
  settings: loadSettings(),
});

/** Apply the theme to <html data-theme> synchronously whenever it changes (before React effects read CSS variables). */
function applyTheme(theme: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}
applyTheme(appStore.getState().settings.theme);
appStore.subscribe((s, prev) => {
  if (s.settings.theme !== prev.settings.theme) applyTheme(s.settings.theme);
});

/** Bound hook: `useAppStore(s => s.papers)`. */
export const useAppStore = appStore;
export type { AppState } from './store';
