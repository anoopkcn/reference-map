# Reference Map

Build an interactive map of the papers a paper cites and the papers that cite it. Start from a DOI, an arXiv id, a URL or a title. Data comes from the [Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/) and [OpenAlex](https://docs.openalex.org/), chosen automatically per request. A standalone, static web app (no backend), the successor to the [Obsidian Reference Map plugin](https://github.com/anoopkcn/obsidian-reference-map).

## Features

- **One input for everything.** Paste a DOI (`10.18653/v1/N18-3011`, `doi.org/...`), an arXiv id (`1706.03762`, `arXiv:...`, `arxiv.org/abs/...`), a Semantic Scholar, OpenAlex, ACL, ACM, bioRxiv or PubMed link, a `CorpusId:` / `PMID:` / `PMCID:` / `MAG:` / `ACL:` id, or several ids at once (one per line). Anything else is searched by title.
- **Seed cards** for each paper in the map: title, authors, venue, abstract on demand, influential-citation count, open-access PDF, copy BibTeX / plain citation / DOI link, refresh and remove buttons.
- **References and citations lists**, loaded lazily, filterable and sortable (year, citations, references, influential citations), windowed so long lists stay smooth. Any row can be added as a seed or expanded in the map.
- **Related papers for the current selection.** Clicking a node or paper row opens its metadata in the right sidebar and loads OpenAlex's algorithmically related works beneath it. Related works are kept separate from citation edges.
- **Expandable reference map.** Seeds in the centre, their references and citations around them. Double-click any node (or press *Expand*) to load its connections; the node becomes a seed, and edges between papers already in the map appear automatically, so the map grows into a real citation network rather than a star. Node size is proportional to citations, colour shows the role (seed, reference, citation, both), hover for details, click for the full card, drag to pin. Removing a seed removes its card, its connections and anything only reachable through it.
- **Two data sources, chosen automatically.** Each request goes to whichever source is healthy and fastest for it. On errors or rate limits the other takes over, and a slow answer is hedged by asking the other source as well. Papers are identified by DOI, arXiv, PubMed or MAG id, so the same paper from either source lands on one node and their data is merged (Semantic Scholar contributes influential-citation counts and BibTeX, OpenAlex venue and open-access links). A single source can be forced in Settings.
- **Rate-limit aware.** Per-source request queues space calls, retry on 429/5xx with backoff, de-duplicate identical requests and show their status in the header. An optional Semantic Scholar API key and an optional OpenAlex contact e-mail (its "polite pool") raise the limits. Both stay in your browser.
- **Shareable and cached.** Seeds live in the URL (`?ids=DOI:...,ARXIV:...`), so a map can be bookmarked or sent to someone; papers, lists and id aliases are cached in IndexedDB for a few days.
- Light and dark theme, keyboard friendly, responsive (tabs for papers and map on narrow screens).

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

Deploy `dist/` to any static host (GitHub Pages, Netlify, Vercel, S3...). The build uses a relative base path, so it works from a sub-directory too.

## Data sources

| | Semantic Scholar | OpenAlex |
|---|---|---|
| Lookups | DOI, arXiv, PMID, PMCID, MAG, ACL, CorpusId, S2 URLs | DOI, PMID, MAG, OpenAlex ids and URLs |
| References / citations | yes | yes (citations sorted by citation count) |
| Title search | yes | yes |
| Extras | influential citations, BibTeX | venue and open-access links, generous limits |

*Automatic* (default) routes each request by capability and health; *Semantic Scholar only* and *OpenAlex only* force one source. arXiv, ACL, CorpusId and URL identifiers can only be looked up on Semantic Scholar. Internally papers get a provider-neutral id (`doi:...`, `arxiv:...`, `pmid:...`, `mag:...`, or `s2:...` / `oa:W...` when nothing better exists); these ids also appear in shareable URLs. Upgrading from an earlier version resets the local cache once.

## Zotero integration

Search your Zotero library as you type (its own section above the web results), seed maps from your papers, and save papers you discover back into Zotero — with the PDF attached when one is available. Three ways to connect:

- **Hosted copy + the Connect plugin** (recommended for hosted use): install the *Reference Map Connect* plugin in Zotero once (`reference-map-connect.xpi` from Releases, or `npm run plugin:build` → Zotero → Tools → Plugins → gear → *Install Plugin From File*), enable *Allow other applications on this computer to communicate with Zotero* in Zotero's Settings → Advanced, then open the app — Zotero shows an Allow/Deny dialog for the site's origin, remembered after one click. Keyless, instant, PDFs included. Chrome/Firefox only — Safari blocks https pages from calling localhost. The plugin never weakens Zotero's own web-page blocking; it adds CORS answers solely for origins you approve.
- **Local, running the app yourself** (`npm run dev`): zero setup beyond the same *Allow other applications…* checkbox — the dev server proxies to Zotero directly, no plugin needed.
- **Hosted copy + local bridge** (no plugin, more manual): run `node scripts/zotero-bridge.mjs https://your-app-origin` (binds to 127.0.0.1, forwards only the origins you list) and put `http://127.0.0.1:23120` into Settings → *Local Zotero bridge URL*.
- **zotero.org API key** (works anywhere, nothing local at all): create a key with library read + write at [zotero.org/settings/keys](https://www.zotero.org/settings/keys/new) and paste it in Settings. Search reflects your synced library; saves go into a remembered collection and arrive in the desktop app via sync, with the PDF as a link attachment.

When both local and key are configured, local wins for search and save; the key covers the times Zotero isn't running.

## Usage tips

- Try `10.18653/v1/N18-3011`, `arXiv:1706.03762`, or `attention is all you need`.
- Double-click a node to expand it; drag a node to pin it (a dot marks pinned nodes); use the toolbar to fit, re-run the layout, unpin all or change label density.
- Clicking empty space in the map does nothing; close the details panel with its X button, Esc, or by selecting another paper.
- If the header shows *S2 limited · Ns*, Semantic Scholar asked us to slow down; OpenAlex keeps working and the request is retried automatically. An [API key](https://www.semanticscholar.org/product/api#api-key-form) (Settings) lifts the Semantic Scholar limits; an e-mail in Settings gets you OpenAlex's faster polite pool.
- Settings also control how many references and citations are fetched per paper (up to 1000) and how many new nodes each expansion adds per direction (highest-cited first; connections to papers already in the map are always drawn).
- To share a map, copy the URL. Seeds (including papers you expanded) are in it; layout, zoom and open lists are not.

## Architecture

```
src/
  lib/        pure helpers: id parsing (ids.ts), provider-neutral identity and aliases (identity.ts),
              formatting, BibTeX generation, sort/filter, URL state
  api/        providers (s2.ts, openalex.ts) behind one Provider interface, the Router (capability and
              health routing, fallback, hedging), request queues with backoff (queue.ts),
              normalisation and merge rules, IndexedDB cache
  store/      zustand store (papers, seeds, lists, settings) and the pure GraphModel (nodes, edges,
              roles, merge, rebuild)
  graph/      layout worker (d3-force off the main thread), bridge, canvas renderer, hit-testing, graph UI
  components/ seed input, index cards, lists, settings, toasts
```

Key design points: one normalised paper store shared by cards, lists and graph; lists are fetched once and reused by the map; graph structure lives in `GraphModel` (O(1) Maps and Sets) and positions in typed arrays exchanged with a Web Worker via transferable buffers; the canvas redraws only when something changed; every provider result is canonicalised through the identity layer before it reaches the store.

## License

MIT
