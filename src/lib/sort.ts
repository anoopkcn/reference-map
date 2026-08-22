import type { Paper, PaperId, SortDir, SortKey } from '../types';

/** Stable sort of ids by a paper field. Never mutates `ids`; unknown papers / null values sort last. */
export function sortIds(ids: readonly PaperId[], papers: ReadonlyMap<PaperId, Paper>, key: SortKey, dir: SortDir): PaperId[] {
  const sign = dir === 'asc' ? 1 : -1;
  const indexed = ids.map((id, i) => ({ id, i, v: valueOf(papers.get(id), key) }));
  indexed.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1;
    if (b.v === null) return -1;
    if (a.v !== b.v) return (a.v - b.v) * sign;
    return a.i - b.i;
  });
  return indexed.map((x) => x.id);
}

function valueOf(p: Paper | undefined, key: SortKey): number | null {
  if (!p) return null;
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Case-insensitive substring filter across title, authors, venue/journal, year and DOI. */
export function filterIds(ids: readonly PaperId[], papers: ReadonlyMap<PaperId, Paper>, query: string): PaperId[] {
  const q = query.trim().toLowerCase();
  if (!q) return ids.slice();
  const terms = q.split(/\s+/);
  return ids.filter((id) => {
    const p = papers.get(id);
    if (!p) return false;
    const hay = haystack(p);
    return terms.every((t) => hay.includes(t));
  });
}

const hayCache = new WeakMap<Paper, string>();
function haystack(p: Paper): string {
  let h = hayCache.get(p);
  if (h === undefined) {
    h = [p.title, p.authors.map((a) => a.name).join(' '), p.venue, p.journal?.name ?? '', p.year ?? '', p.externalIds.DOI ?? '']
      .join(' ')
      .toLowerCase();
    hayCache.set(p, h);
  }
  return h;
}
