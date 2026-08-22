import { MemoryCache } from '../api/cache';
import { OA_QUEUE, OpenAlexClient } from '../api/openalex';
import { RequestQueue } from '../api/queue';
import { Router } from '../api/router';
import { S2Client } from '../api/s2';
import { Identity } from '../lib/identity';
import { loadSettings } from './settings';
import { createAppStore } from './store';

export const startupCache = new MemoryCache();
export const s2Queue = new RequestQueue();
export const oaQueue = new RequestQueue(OA_QUEUE);
export const identity = new Identity(startupCache);
export const s2 = new S2Client({ queue: s2Queue, getApiKey: () => appStore.getState().settings.apiKey });
export const openalex = new OpenAlexClient({ queue: oaQueue, getMailto: () => appStore.getState().settings.openalexEmail });
export const router = new Router({ providers: [s2, openalex], identity, getMode: () => appStore.getState().settings.sourceMode });

export const appStore = createAppStore({ router, identity, cache: startupCache, settings: loadSettings() });

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
