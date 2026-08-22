import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { createCache } from './api/cache';
import { appStore, queue } from './store';

const cache = await createCache();
appStore.setCache(cache);

if (import.meta.env.DEV) {
  (window as unknown as { __refmap: unknown }).__refmap = { store: appStore, queue, cache };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
