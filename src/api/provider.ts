import type { DetailLevel, ListKind, Lookup, Paper, PaperId, ProviderId } from '../types';
import { describeError, isAbort } from './errors';
import type { EnqueueOptions, RequestQueue } from './queue';

export type OpKind = 'resolve' | 'detail' | 'refs' | 'cites' | 'batch' | 'search';

export const PRIORITY = { seed: 3, detail: 2, list: 1, search: 2, batch: 3 } as const;

export interface ListResult {
  /** Ids in provider order (provisional until canonicalised by the Router). */
  ids: PaperId[];
  papers: Paper[];
  hasMore: boolean;
  /** Total reported by the provider, if known. */
  total: number | null;
}

export interface SearchResult {
  papers: Paper[];
  total: number;
}

/** Per-provider health: EWMA service latency per operation + recent error timestamps. */
export class ProviderStats {
  private ewmas = new Map<OpKind, number>();
  private errorTimes: number[] = [];
  lastError: string | undefined;
  private listeners = new Set<() => void>();

  constructor(private now: () => number = () => Date.now()) {}

  record(op: OpKind, ok: boolean, ms: number, err?: unknown): void {
    if (ok) {
      const prev = this.ewmas.get(op);
      this.ewmas.set(op, prev === undefined ? ms : prev * 0.7 + ms * 0.3);
    } else if (!isAbort(err)) {
      const t = this.now();
      this.errorTimes.push(t);
      if (this.errorTimes.length > 50) this.errorTimes.splice(0, this.errorTimes.length - 50);
      this.lastError = describeError(err);
    } else return;
    for (const l of this.listeners) l();
  }

  ewma(op: OpKind): number {
    return this.ewmas.get(op) ?? 0;
  }

  recentErrors(windowMs = 60_000): number {
    const cutoff = this.now() - windowMs;
    return this.errorTimes.filter((t) => t >= cutoff).length;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/** A data source. Papers it returns carry a provisional `paperId` (`s2:<sha>` / `oa:W…`) and exactly one `sources` entry. */
export interface Provider {
  readonly id: ProviderId;
  readonly queue: RequestQueue;
  readonly stats: ProviderStats;
  /** Native id for a lookup, or null when this provider cannot handle that kind of id. */
  toNative(lookup: Lookup): string | null;
  /** Native id (or an accepted external id) for a known paper, or null. */
  lookupFor(paper: Pick<Paper, 'sources' | 'externalIds'>): string | null;
  resolve(lookup: Lookup, level: DetailLevel, options?: EnqueueOptions): Promise<Paper>;
  getPaper(native: string, level: DetailLevel, options?: EnqueueOptions): Promise<Paper>;
  getList(native: string, kind: ListKind, limit: number, options?: EnqueueOptions): Promise<ListResult>;
  /** Aligned with input; null for misses or unsupported lookups. */
  getBatch(lookups: readonly Lookup[], level: DetailLevel, options?: EnqueueOptions): Promise<(Paper | null)[]>;
  search(query: string, limit: number, options?: EnqueueOptions): Promise<SearchResult>;
}
