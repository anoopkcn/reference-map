import type { Lookup, PaperId } from '../types';

export interface UrlState {
  lookups: Lookup[];
  sel: PaperId | null;
}

/** Encode a lookup for the `ids` query param: keep `:` and `/` readable, escape delimiters. */
function encodeLookup(l: Lookup): string {
  return encodeURIComponent(l).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}

/** Pure: state → query string ("" when empty, otherwise "?ids=…&sel=…"). */
export function encodeUrlState(state: UrlState): string {
  const parts: string[] = [];
  if (state.lookups.length) parts.push('ids=' + state.lookups.map(encodeLookup).join(','));
  if (state.sel) parts.push('sel=' + encodeURIComponent(state.sel));
  return parts.length ? '?' + parts.join('&') : '';
}

/** Pure: query string (with or without leading "?") → state. Splits on raw commas before decoding. */
export function decodeUrlState(search: string): UrlState {
  const qs = search.startsWith('?') ? search.slice(1) : search;
  let lookups: Lookup[] = [];
  let sel: PaperId | null = null;
  for (const part of qs.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 'ids') {
      lookups = v
        .split(',')
        .map((s) => safeDecode(s).trim())
        .filter(Boolean);
    } else if (k === 'sel') {
      const d = safeDecode(v).trim();
      sel = d || null;
    }
  }
  return { lookups, sel };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

export function readUrlState(): UrlState {
  if (typeof window === 'undefined') return { lookups: [], sel: null };
  return decodeUrlState(window.location.search);
}

export function writeUrlState(state: UrlState): void {
  if (typeof window === 'undefined') return;
  const qs = encodeUrlState(state);
  const next = window.location.pathname + qs + window.location.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) window.history.replaceState(null, '', next);
}
