/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** The parts of Node's req/res the bridge middleware touches (@types/node isn't a dependency). */
interface BridgeReq extends AsyncIterable<Uint8Array> {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface BridgeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: Uint8Array): void;
}

/**
 * Same-origin bridge to the running Zotero app's local server (it sends no CORS headers, so
 * the browser cannot call localhost:23119 directly). Dev-only: hosted builds reach Zotero via
 * the Reference Map Connect plugin instead, and the client gates everything on import.meta.env.DEV.
 *
 * This is a hand-rolled middleware rather than `server.proxy` because Vite logs every proxy
 * connection failure to the terminal — and with Zotero closed, the app's reachability probes
 * would spam "http proxy error: … ECONNREFUSED" on load, focus, and search. Here a dead
 * upstream is just a quiet 502, which the app already treats as "Zotero isn't running".
 */
function zoteroLocalBridge(): Plugin {
  const target = 'http://127.0.0.1:23119';
  // Zotero's local server drops requests that look like they come from a web page
  // (browser User-Agent, Origin) — this bridge is the user's own same-machine path.
  const dropHeaders = new Set(['host', 'origin', 'referer', 'user-agent', 'connection', 'content-length', 'accept-encoding']);
  return {
    name: 'zotero-local-bridge',
    configureServer(server) {
      server.middlewares.use('/zotero-local', (rawReq, rawRes) => {
        const req = rawReq as unknown as BridgeReq;
        const res = rawRes as unknown as BridgeRes;
        void (async () => {
          try {
            const chunks: Uint8Array[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length ? new Blob(chunks as BlobPart[]) : undefined;
            const headers: Record<string, string> = { 'user-agent': 'reference-map (local Zotero bridge)' };
            for (const [name, value] of Object.entries(req.headers)) {
              if (typeof value === 'string' && !dropHeaders.has(name.toLowerCase())) headers[name] = value;
            }
            const upstream = await fetch(target + (req.url ?? ''), { method: req.method ?? 'GET', headers, body });
            res.statusCode = upstream.status;
            upstream.headers.forEach((value, name) => {
              if (!['transfer-encoding', 'connection', 'content-length', 'content-encoding'].includes(name)) res.setHeader(name, value);
            });
            res.end(new Uint8Array(await upstream.arrayBuffer()));
          } catch {
            res.statusCode = 502; // Zotero isn't running — the app handles this quietly
            res.end();
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), zoteroLocalBridge()],
  // Relative base so the built site works from any static path (GitHub Pages sub-path, etc.)
  base: './',
  build: { target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
