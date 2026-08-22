import type { Paper } from '../types';
import { doiUrl, surname, venueLine } from './format';

function esc(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** Generate a BibTeX entry from our metadata (used when the provider has none, e.g. OpenAlex). */
export function generateBibtex(p: Paper): string {
  const first = p.authors[0]?.name ?? '';
  const year = p.year ? String(p.year) : '';
  const firstWord = (p.title.match(/[A-Za-z][A-Za-z0-9]+/g) ?? []).find((w) => !/^(a|an|the|on|of|in|for|to|and|with|from|by)$/i.test(w)) ?? 'paper';
  const key = `${surname(first).replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'anon'}${year}${firstWord.toLowerCase()}`;
  const isConf = p.publicationTypes.includes('Conference');
  const venue = venueLine({ venue: p.venue, journal: p.journal ? { name: p.journal.name } : null });
  const type = venue ? (isConf ? 'inproceedings' : 'article') : 'misc';
  const fields: [string, string | undefined][] = [
    ['title', esc(p.title)],
    ['author', p.authors.length ? p.authors.map((a) => esc(a.name)).join(' and ') : undefined],
    ['year', year || undefined],
    [isConf ? 'booktitle' : 'journal', venue || undefined],
    ['volume', p.journal?.volume],
    ['pages', p.journal?.pages?.replace(/-+/g, '--')],
    ['doi', p.externalIds.DOI],
    ['url', doiUrl(p) ?? (p.externalIds.ArXiv ? `https://arxiv.org/abs/${p.externalIds.ArXiv}` : undefined)],
  ];
  const body = fields
    .filter((f): f is [string, string] => !!f[1])
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(',\n');
  return `@${type}{${key},\n${body}\n}`;
}
