#!/usr/bin/env node
/**
 * zotero-bridge — lets a HOSTED copy of Reference Map talk to the Zotero app on THIS computer.
 *
 * Zotero's local server deliberately refuses requests from web pages (it sends no CORS headers
 * and drops browser-looking requests), so a copy of the app served from the web cannot reach it.
 * This bridge forwards requests from origins YOU explicitly allow — and nothing else — to the
 * local Zotero server, answering the CORS/preflight handshake the browser requires.
 * It binds to 127.0.0.1 only and never accepts remote connections.
 *
 * Usage:   node zotero-bridge.mjs <allowed-origin> [more-origins...]
 * Example: node zotero-bridge.mjs https://yourname.github.io
 *
 * Then in the app: Settings → "Local Zotero bridge URL" → http://127.0.0.1:23120
 * (Chrome and Firefox; Safari blocks https pages from calling localhost.)
 */
import http from 'node:http';

const ZOTERO = { host: '127.0.0.1', port: 23119 };
const PORT = Number(process.env.PORT || 23120);

const allowed = new Set(process.argv.slice(2).map((o) => o.replace(/\/+$/, '')));
if (allowed.size === 0) {
  console.error('Usage: node zotero-bridge.mjs <allowed-origin> [more-origins...]');
  console.error('  e.g. node zotero-bridge.mjs https://yourname.github.io');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const origin = (req.headers.origin ?? '').replace(/\/+$/, '');
  // Origin-less requests (curl, local tools) could reach Zotero directly anyway; web pages
  // always send Origin on cross-origin requests, and only allowlisted ones get through.
  if (origin && !allowed.has(origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Origin not allowed by zotero-bridge');
    return;
  }
  const cors = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Expose-Headers': 'Total-Results, Last-Modified-Version, Retry-After, Backoff',
        Vary: 'Origin',
      }
    : {};

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST, HEAD',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
      // Chrome's Private Network Access preflight for public→local requests.
      ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // Zotero drops requests with a browser User-Agent or an Origin header — present as a local app.
  const headers = { ...req.headers, host: `${ZOTERO.host}:${ZOTERO.port}`, 'user-agent': 'reference-map (zotero-bridge)' };
  delete headers.origin;
  delete headers.referer;

  const proxied = http.request({ ...ZOTERO, path: req.url, method: req.method, headers }, (zres) => {
    res.writeHead(zres.statusCode ?? 502, { ...zres.headers, ...cors });
    zres.pipe(res);
  });
  proxied.on('error', () => {
    res.writeHead(502, { ...cors, 'Content-Type': 'text/plain' });
    res.end('Zotero is not reachable — is the Zotero app running?');
  });
  req.pipe(proxied);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`zotero-bridge listening on http://127.0.0.1:${PORT} → Zotero at ${ZOTERO.host}:${ZOTERO.port}`);
  console.log(`allowed origins: ${[...allowed].join(', ')}`);
});
