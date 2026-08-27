/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/** The parts of Node's ClientRequest the proxy hook touches (@types/node isn't a dependency). */
interface ProxiedRequest {
  setHeader(name: string, value: string): void;
  removeHeader(name: string): void;
}

// Same-origin bridge to the running Zotero app's read-only local API (its server
// sends no CORS headers, so the browser cannot call localhost:23119 directly).
// Dev-only: the client code gates local features on import.meta.env.DEV to match,
// so statically hosted builds fall back to the zotero.org API and say so in the UI.
const zoteroLocalProxy: Record<string, ProxyOptions> = {
  '/zotero-local': {
    target: 'http://127.0.0.1:23119',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/zotero-local/, ''),
    configure(proxy) {
      const server = proxy as unknown as { on(event: 'proxyReq', cb: (proxyReq: ProxiedRequest) => void): void };
      server.on('proxyReq', (proxyReq) => {
        // Zotero's local server drops requests that look like they come from a web page
        // (browser User-Agent, Origin) — this proxy is the user's own same-machine bridge.
        proxyReq.setHeader('User-Agent', 'reference-map (local Zotero bridge)');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  // Relative base so the built site works from any static path (GitHub Pages sub-path, etc.)
  base: './',
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  server: { proxy: zoteroLocalProxy },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
