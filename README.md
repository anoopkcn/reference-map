# Reference Map

Build an interactive map of the papers a paper cites and the papers that cite it — starting from a DOI, an arXiv id, a URL or a title — using the [Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/). A standalone, static web app (no backend): the successor to the [Obsidian Reference Map plugin](https://github.com/anoopkcn/obsidian-reference-map).

## Features

- **One input for everything** — paste a DOI (`10.18653/v1/N18-3011`, `doi.org/…`), an arXiv id (`1706.03762`, `arXiv:…`, `arxiv.org/abs/…`), a Semantic Scholar / ACL / ACM / bioRxiv / PubMed link, a `CorpusId:` / `PMID:` / `PMCID:` / `MAG:` / `ACL:` id, or several ids at once (one per line). Anything else is searched by title.
- **Index cards** for each seed paper: title, authors, venue, abstract on demand, reference / citation counts, open-access PDF, copy BibTeX / plain citation / DOI link.
- **Cited & citing lists** — loaded lazily, filterable, sortable (year, citations, references, influential citations), windowed so 1000-row lists stay smooth. Any row can be added as a seed or expanded in the map.
- **Expandable reference map** — seeds in the centre, their references and citations around them. Double-click any node (or press *Expand*) to load *its* connections; edges between papers already in the map appear automatically, so the map grows into a real citation network rather than a star. Node size ∝ citations, colour by role (seed / cited / citing / both), hover for details, click for the full card, drag to pin.
- **Two data sources, chosen automatically** — Semantic Scholar and OpenAlex. Each request goes to whichever source is healthy and fastest for it; on errors or rate limits the other takes over, and a slow answer is hedged by asking the other source too. Papers are identified by DOI / arXiv / PubMed / MAG id, so the same paper from either source lands on one node, and their data is merged (S2's influential-citation counts and BibTeX, OpenAlex's venue and open-access links). You can also force a single source in Settings.
- **Rate-limit aware** — per-source request queues space calls, retry on 429/5xx with backoff, de-duplicate identical requests and show their status in the header. Optional Semantic Scholar API key and OpenAlex contact e-mail ("polite pool") for higher limits — both stored only in your browser.
- **Shareable & cached** — seeds live in the URL (`?ids=DOI:…,ARXIV:…`) so maps can be bookmarked; papers and lists are cached in IndexedDB for a few days.
- Light / dark theme, keyboard friendly, responsive.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

```bash
npm run build      # typecheck + production build into dist/ (static, deploy anywhere)
npm run preview    # serve the production build locally
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
```

Deploy `dist/` to any static host (GitHub Pages, Netlify, Vercel, S3…). The build uses a relative base path, so it works from a sub-directory too.

## Data sources

| | Semantic Scholar | OpenAlex |
|---|---|---|
| Lookups | DOI, arXiv, PMID, PMCID, MAG, ACL, CorpusId, S2 URLs | DOI, PMID, MAG, OpenAlex ids/URLs |
| References / citations | ✅ | ✅ (citations sorted by citation count) |
| Title search | ✅ | ✅ |
| Extras | influential citations, BibTeX | venue / open-access links; generous limits |

*Automatic* (default) routes each request by capability and health; *Semantic Scholar only* / *OpenAlex only* force one source. arXiv, ACL, CorpusId and URL identifiers can only be looked up on Semantic Scholar. Internally papers get a provider-neutral id (`doi:…`, `arxiv:…`, `pmid:…`, `mag:…`, or `s2:…` / `oa:W…` when nothing better exists); these ids also appear in shareable URLs. Upgrading from an earlier version resets the local cache once.

## Usage tips

- Try `10.18653/v1/N18-3011`, `arXiv:1706.03762`, or `attention is all you need`.
- **Double-click** a node to expand it; **drag** a node to pin it (dot = pinned); use the toolbar to fit, re-run the layout, unpin all or change label density.
- The public Semantic Scholar API is shared and throttled; if you see *S2 limited · Ns* the app is waiting on that source (OpenAlex keeps working) and will continue automatically. An [API key](https://www.semanticscholar.org/product/api#api-key-form) (Settings → API key) lifts the limits; an e-mail in Settings gets you OpenAlex's faster polite pool.
- *Settings* also control how many references / citations are fetched per paper (≤ 1000) and how many new nodes each expansion adds per direction (highest-cited first; connections to papers already in the map are always drawn).

## Architecture

```
src/
  lib/        pure helpers: id parsing (ids.ts), provider-neutral identity/aliases (identity.ts), formatting, BibTeX, sort/filter, URL state
  api/        providers (s2.ts, openalex.ts) behind one Provider interface, the Router (capability + health routing, fallback, hedging),
              request queues with backoff (queue.ts), normalisation/merge rules, IndexedDB cache
  store/      zustand store (papers, seeds, lists, settings) and the pure GraphModel (nodes/edges/roles/merge)
  graph/      layout worker (d3-force off the main thread), bridge, canvas renderer, hit-testing, graph UI
  components/ seed input, index cards, lists, settings, toasts
```

Key design points: one normalised paper store shared by cards, lists and graph; lists fetched once and reused by the map; graph structure lives in `GraphModel` (O(1) Maps/Sets) and positions in typed arrays exchanged with a Web Worker via transferable buffers; the canvas redraws only when something changed.

## License

MIT
