import type { Identity } from '../lib/identity';
import type { DetailLevel, ListKind, Lookup, Paper, ProviderId, SourceMode } from '../types';
import { ApiError, NotFoundError, UnsupportedLookupError, isAbort } from './errors';
import type { ListResult, OpKind, Provider, SearchResult } from './provider';
import type { EnqueueOptions } from './queue';

export interface ProviderStatus {
  id: ProviderId;
  pending: number;
  active: number;
  pausedUntil: number | null;
  ewmaMs: number;
  recentErrors: number;
  lastError?: string;
  score: number;
}

export interface RouterOptions {
  providers: Provider[];
  identity: Identity;
  getMode: () => SourceMode;
  /** Start a hedge request on the next provider if the primary has not answered within this time. */
  softTimeoutMs?: number;
  maxHedgeMs?: number;
  now?: () => number;
}

const ERROR_PENALTY_MS = 2000;
const TIE_MS = 300;

type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: unknown } | { kind: 'timeout' };

/**
 * Chooses a provider per request (capability + health), falls back sequentially on errors,
 * hedges when the primary is slow, and canonicalises every paper through Identity.
 */
export class Router {
  readonly providers: Partial<Record<ProviderId, Provider>> = {};
  private order: Provider[];
  private identity: Identity;
  private getMode: () => SourceMode;
  private softTimeoutMs: number;
  private maxHedgeMs: number;
  private now: () => number;
  private listeners = new Set<(s: Record<ProviderId, ProviderStatus>) => void>();

  constructor(opts: RouterOptions) {
    this.order = opts.providers;
    for (const p of opts.providers) this.providers[p.id] = p;
    this.identity = opts.identity;
    this.getMode = opts.getMode;
    this.softTimeoutMs = opts.softTimeoutMs ?? 4000;
    this.maxHedgeMs = opts.maxHedgeMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
    for (const p of opts.providers) {
      p.queue.onStatus(() => this.emit());
      p.stats.onChange(() => this.emit());
    }
  }

  // ---------- public API ----------

  async resolve(lookup: Lookup, level: DetailLevel, o: EnqueueOptions = {}): Promise<Paper> {
    const cands = this.candidates('resolve', (p) => p.toNative(lookup) !== null, lookup);
    const paper = await this.run('resolve', cands, (p, signal) => p.resolve(lookup, level, { ...o, signal }), o.signal);
    await this.identity.assign([paper]);
    return paper;
  }

  async getPaper(paper: Paper, level: DetailLevel, o: EnqueueOptions = {}): Promise<Paper> {
    const cands = this.candidates('detail', (p) => p.lookupFor(paper) !== null, paper.paperId);
    const fresh = await this.run('detail', cands, (p, signal) => p.getPaper(p.lookupFor(paper)!, level, { ...o, signal }), o.signal);
    await this.identity.assign([fresh]);
    return fresh;
  }

  async getList(paper: Paper, kind: ListKind, limit: number, o: EnqueueOptions = {}): Promise<ListResult & { provider: ProviderId }> {
    const cands = this.candidates(kind, (p) => p.lookupFor(paper) !== null, paper.paperId);
    const { value, provider } = await this.runTagged(kind, cands, (p, signal) => p.getList(p.lookupFor(paper)!, kind, limit, { ...o, signal }), o.signal);
    await this.identity.assign(value.papers);
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const p of value.papers) {
      if (p.paperId === paper.paperId || seen.has(p.paperId)) continue;
      seen.add(p.paperId);
      ids.push(p.paperId);
    }
    return { ...value, ids, provider };
  }

  /** Aligned with input. Each lookup goes to the best capable provider; misses get one more try elsewhere. */
  async getBatch(lookups: readonly Lookup[], level: DetailLevel, o: EnqueueOptions = {}): Promise<(Paper | null)[]> {
    const results: (Paper | null)[] = new Array(lookups.length).fill(null);
    if (lookups.length === 0) return results;
    const sorted = this.sortedProviders('batch');
    const remaining = new Set(lookups.map((_, i) => i));
    const tried = lookups.map(() => new Set<ProviderId>());
    while (remaining.size) {
      const groups = new Map<Provider, number[]>();
      for (const i of [...remaining]) {
        const p = sorted.find((pr) => !tried[i]!.has(pr.id) && pr.toNative(lookups[i]!) !== null);
        if (!p) {
          remaining.delete(i);
          continue;
        }
        tried[i]!.add(p.id);
        const g = groups.get(p) ?? [];
        g.push(i);
        groups.set(p, g);
      }
      if (groups.size === 0) break;
      await Promise.all(
        [...groups].map(async ([p, idxs]) => {
          try {
            const res = await p.getBatch(
              idxs.map((i) => lookups[i]!),
              level,
              o,
            );
            res.forEach((r, j) => {
              if (r) {
                results[idxs[j]!] = r;
                remaining.delete(idxs[j]!);
              }
            });
          } catch (e) {
            if (isAbort(e)) throw e;
            // provider recorded the failure in its stats; remaining lookups get another provider next pass
          }
        }),
      );
    }
    await this.identity.assign(results.filter((p): p is Paper => !!p));
    return results;
  }

  async search(query: string, limit: number, o: EnqueueOptions = {}): Promise<SearchResult & { provider: ProviderId }> {
    const cands = this.candidates('search', () => true, query);
    const { value, provider } = await this.runTagged('search', cands, (p, signal) => p.search(query, limit, { ...o, signal }), o.signal);
    await this.identity.assign(value.papers);
    return { ...value, provider };
  }

  status(): Record<ProviderId, ProviderStatus> {
    const now = this.now();
    const out = {} as Record<ProviderId, ProviderStatus>;
    for (const p of this.order) {
      const q = p.queue.status();
      out[p.id] = {
        id: p.id,
        pending: q.pending,
        active: q.active,
        pausedUntil: q.pausedUntil,
        ewmaMs: Math.round(p.stats.ewma('detail') || p.stats.ewma('refs') || p.stats.ewma('resolve')),
        recentErrors: p.stats.recentErrors(),
        lastError: p.stats.lastError,
        score: Math.round(this.score(p, 'detail', now)),
      };
    }
    return out;
  }

  onStatus(cb: (s: Record<ProviderId, ProviderStatus>) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---------- internals ----------

  private emit(): void {
    if (this.listeners.size === 0) return;
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  /** Lower is better: expected service latency + queue backlog + remaining 429 pause + error penalty. */
  private score(p: Provider, op: OpKind, now: number): number {
    const q = p.queue.status();
    const opts = p.queue.options;
    const backlog = ((q.pending + q.active) * opts.minIntervalMs) / Math.max(1, opts.concurrency);
    const pause = q.pausedUntil ? Math.max(0, q.pausedUntil - now) : 0;
    return p.stats.ewma(op) + backlog + pause + ERROR_PENALTY_MS * p.stats.recentErrors();
  }

  private sortedProviders(op: OpKind): Provider[] {
    const mode = this.getMode();
    const list = this.order.filter((p) => mode === 'auto' || p.id === mode);
    const now = this.now();
    const scored = list.map((p, i) => ({ p, i, s: this.score(p, op, now) }));
    scored.sort((a, b) => (Math.abs(a.s - b.s) < TIE_MS ? a.i - b.i : a.s - b.s));
    return scored.map((x) => x.p);
  }

  private candidates(op: OpKind, capable: (p: Provider) => boolean, what: string): Provider[] {
    const mode = this.getMode();
    const cands = this.sortedProviders(op).filter(capable);
    if (cands.length === 0) throw new UnsupportedLookupError(what, mode === 'auto' ? undefined : mode);
    return cands;
  }

  private async run<T>(op: OpKind, cands: Provider[], call: (p: Provider, signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    return (await this.runTagged(op, cands, call, outer)).value;
  }

  private async runTagged<T>(
    op: OpKind,
    cands: Provider[],
    call: (p: Provider, signal: AbortSignal) => Promise<T>,
    outer?: AbortSignal,
  ): Promise<{ value: T; provider: ProviderId }> {
    const errors: unknown[] = [];
    let i = 0;
    while (i < cands.length) {
      if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');
      const primary = cands[i]!;
      const ctrlA = linkAbort(outer);
      const pA = this.attempt(op, primary, call, ctrlA.signal);
      const rest = cands.slice(i + 1);
      if (rest.length === 0) {
        try {
          return { value: await pA, provider: primary.id };
        } catch (e) {
          if (isAbort(e)) throw e;
          errors.push(e);
          break;
        }
      }
      const soft = Math.min(this.maxHedgeMs, Math.max(this.softTimeoutMs, 2 * primary.stats.ewma(op)));
      const r = await raceTimeout(pA, soft);
      if (r.kind === 'ok') return { value: r.value, provider: primary.id };
      if (r.kind === 'err') {
        if (isAbort(r.error)) throw r.error;
        errors.push(r.error);
        i += 1;
        continue;
      }
      // Primary is slow: hedge with exactly one other provider; first success wins, the loser is aborted.
      const hedge = rest[0]!;
      const ctrlB = linkAbort(outer);
      const pB = this.attempt(op, hedge, call, ctrlB.signal);
      const w = await firstFulfilled([pA, pB]);
      if (w.ok) {
        (w.index === 0 ? ctrlB : ctrlA).abort();
        return { value: w.value, provider: w.index === 0 ? primary.id : hedge.id };
      }
      for (const e of w.errors) if (isAbort(e)) throw e;
      errors.push(...w.errors);
      i += 2;
    }
    throw aggregate(errors);
  }

  /** Wrap a provider call: never leaves an unhandled rejection behind when it loses a hedge. */
  private attempt<T>(_op: OpKind, p: Provider, call: (p: Provider, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = call(p, signal);
    } catch (e) {
      promise = Promise.reject(e);
    }
    promise.catch(() => {});
    return promise;
  }
}

function linkAbort(outer?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    p.then(
      (value) => {
        clearTimeout(t);
        resolve({ kind: 'ok', value });
      },
      (error) => {
        clearTimeout(t);
        resolve({ kind: 'err', error });
      },
    );
  });
}

function firstFulfilled<T>(ps: Promise<T>[]): Promise<{ ok: true; index: number; value: T } | { ok: false; errors: unknown[] }> {
  return new Promise((resolve) => {
    let pending = ps.length;
    let done = false;
    const errors: unknown[] = new Array(ps.length);
    ps.forEach((p, i) =>
      p.then(
        (value) => {
          if (!done) {
            done = true;
            resolve({ ok: true, index: i, value });
          }
        },
        (e) => {
          errors[i] = e;
          if (--pending === 0 && !done) resolve({ ok: false, errors });
        },
      ),
    );
  });
}

function aggregate(errors: unknown[]): unknown {
  if (errors.length === 0) return new Error('No provider available');
  if (errors.every((e) => e instanceof NotFoundError)) return new NotFoundError('Not found');
  return errors.find((e) => !(e instanceof NotFoundError) && !(e instanceof UnsupportedLookupError)) ?? errors[0];
}

export { ApiError };
