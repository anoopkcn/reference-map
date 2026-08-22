import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { createCache, setOnIdbLate } from './api/cache';
import { appStore, identity, oaQueue, router, s2Queue, startupCache } from './store';

const cachePromise = createCache(3000, startupCache);
void appStore.prepareCache(cachePromise);
setOnIdbLate((late) => void appStore.prepareCache(Promise.resolve(late)));

if (import.meta.env.DEV) {
  (window as unknown as { __refmap: unknown }).__refmap = { store: appStore, router, identity, s2Queue, oaQueue, cachePromise };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
