import { DEFAULT_SETTINGS, type Settings } from '../types';
import { S2_LIMITS } from '../api/fields';

const KEY = 'refmap.settings.v1';

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Validate/normalize a partial settings object against defaults. */
export function sanitizeSettings(input: Partial<Settings> | null | undefined): Settings {
  const s = input ?? {};
  return {
    apiKey: typeof s.apiKey === 'string' ? s.apiKey.trim() : DEFAULT_SETTINGS.apiKey,
    openalexEmail: typeof s.openalexEmail === 'string' ? s.openalexEmail.trim() : DEFAULT_SETTINGS.openalexEmail,
    sourceMode: oneOf(s.sourceMode, ['auto', 's2', 'openalex'] as const, DEFAULT_SETTINGS.sourceMode),
    listLimit: clampInt(s.listLimit, 50, S2_LIMITS.list, DEFAULT_SETTINGS.listLimit),
    graphExpandLimit: clampInt(s.graphExpandLimit, 10, S2_LIMITS.list, DEFAULT_SETTINGS.graphExpandLimit),
    autoExpandSeeds: typeof s.autoExpandSeeds === 'boolean' ? s.autoExpandSeeds : DEFAULT_SETTINGS.autoExpandSeeds,
    labelMode: oneOf(s.labelMode, ['seeds', 'auto', 'all'] as const, DEFAULT_SETTINGS.labelMode),
    theme: oneOf(s.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    sortKey: oneOf(s.sortKey, ['year', 'citationCount', 'referenceCount', 'influentialCitationCount'] as const, DEFAULT_SETTINGS.sortKey),
    sortDir: oneOf(s.sortDir, ['asc', 'desc'] as const, DEFAULT_SETTINGS.sortDir),
  };
}

export function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizeSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}
