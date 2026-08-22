import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { createCache, setOnIdbLate } from './api/cache';
import { appStore, identity, oaQueue, router, s2Queue } from './store';

setOnIdbLate((late) => appStore.setCache(late));
const cache = await createCache();
appStore.setCache(cache);

if (import.meta.env.DEV) {
  (window as unknown as { __refmap: unknown }).__refmap = { store: appStore, router, identity, s2Queue, oaQueue, cache };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
