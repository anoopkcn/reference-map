import { AbortedError, NetworkError, RateLimitedError, S2Error, isAbort } from './errors';

export interface QueueOptions {
  /** Max in-flight requests. */
  concurrency: number;
  /** Min spacing between request starts (ms). */
  minIntervalMs: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export interface QueueStatus {
  pending: number;
  active: number;
  /** Epoch ms until which the queue is paused after a 429, or null. */
  pausedUntil: number | null;
}

export interface EnqueueOptions {
  /** Higher runs first. */
  priority?: number;
  signal?: AbortSignal;
}

interface Job<T = unknown> {
  key: string;
  run: (signal: AbortSignal) => Promise<T>;
  priority: number;
  seq: number;
  attempt: number;
  notBefore: number;
  refs: number;
  ctrl: AbortController;
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export const UNAUTH_QUEUE: Pick<QueueOptions, 'concurrency' | 'minIntervalMs'> = { concurrency: 1, minIntervalMs: 1100 };
export const AUTH_QUEUE: Pick<QueueOptions, 'concurrency' | 'minIntervalMs'> = { concurrency: 2, minIntervalMs: 450 };

/**
 * Serialises requests to a rate-limited API: bounded concurrency, minimum spacing between starts,
 * global pause + retry on 429 (honouring Retry-After), exponential backoff on 5xx/network errors,
 * de-duplication of identical in-flight requests, and ref-counted cancellation.
 */
export class RequestQueue {
  private opts: QueueOptions;
  private pending: Job[] = [];
  private inflight = new Map<string, Job>();
  private active = 0;
  private nextSlotAt = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private listeners = new Set<(s: QueueStatus) => void>();

  constructor(opts: Partial<QueueOptions> = {}) {
    this.opts = { ...UNAUTH_QUEUE, maxRetries: 5, baseBackoffMs: 1000, maxBackoffMs: 60_000, ...opts };
  }

  configure(patch: Partial<QueueOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.pump();
  }

  get options(): Readonly<QueueOptions> {
    return this.opts;
  }

  status(): QueueStatus {
    return { pending: this.pending.length, active: this.active, pausedUntil: this.pausedUntil > Date.now() ? this.pausedUntil : null };
  }

  onStatus(fn: (s: QueueStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueue<T>(key: string, run: (signal: AbortSignal) => Promise<T>, options: EnqueueOptions = {}): Promise<T> {
    const existing = this.inflight.get(key) as Job<T> | undefined;
    if (existing) {
      existing.refs++;
      if (options.priority !== undefined && options.priority > existing.priority) {
        existing.priority = options.priority;
        this.resort();
      }
      this.attachAbort(existing, options.signal);
      return existing.promise;
    }
    if (options.signal?.aborted) return Promise.reject(new AbortedError());

    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Avoid unhandled-rejection noise for deduped consumers that have their own handlers.
    promise.catch(() => {});
    const job: Job<T> = {
      key,
      run,
      priority: options.priority ?? 0,
      seq: this.seq++,
      attempt: 0,
      notBefore: 0,
      refs: 1,
      ctrl: new AbortController(),
      promise,
      resolve,
      reject,
    };
    this.inflight.set(key, job as Job);
    this.insert(job as Job);
    this.attachAbort(job, options.signal);
    this.pump();
    return promise;
  }

  private attachAbort<T>(job: Job<T>, signal?: AbortSignal): void {
    if (!signal) return;
    const onAbort = () => {
      job.refs--;
      if (job.refs > 0) return;
      const i = this.pending.indexOf(job as Job);
      if (i >= 0) {
        this.pending.splice(i, 1);
        this.inflight.delete(job.key);
        job.reject(new AbortedError());
        this.emit();
      } else {
        job.ctrl.abort();
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  private insert(job: Job): void {
    let i = this.pending.length;
    while (i > 0) {
      const prev = this.pending[i - 1]!;
      if (prev.priority > job.priority || (prev.priority === job.priority && prev.seq <= job.seq)) break;
      i--;
    }
    this.pending.splice(i, 0, job);
  }

  private resort(): void {
    this.pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, ms));
  }

  private pump(): void {
    const now = Date.now();
    if (this.pausedUntil > now) {
      this.schedule(this.pausedUntil - now);
      this.emit();
      return;
    }
    while (this.active < this.opts.concurrency && this.pending.length > 0) {
      let idx = -1;
      let soonest = Infinity;
      for (let i = 0; i < this.pending.length; i++) {
        const nb = this.pending[i]!.notBefore;
        if (nb <= now) {
          idx = i;
          break;
        }
        if (nb < soonest) soonest = nb;
      }
      if (idx < 0) {
        this.schedule(soonest - now);
        break;
      }
      if (this.nextSlotAt > now) {
        this.schedule(this.nextSlotAt - now);
        break;
      }
      const job = this.pending.splice(idx, 1)[0]!;
      this.active++;
      this.nextSlotAt = now + this.opts.minIntervalMs;
      this.start(job);
    }
    this.emit();
  }

  private start(job: Job): void {
    let p: Promise<unknown>;
    try {
      p = job.run(job.ctrl.signal);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (v) => this.finish(job, v),
      (e) => this.fail(job, e),
    );
  }

  private finish(job: Job, value: unknown): void {
    this.active--;
    this.inflight.delete(job.key);
    job.resolve(value);
    this.pump();
  }

  private fail(job: Job, err: unknown): void {
    this.active--;
    const now = Date.now();
    if (job.ctrl.signal.aborted || isAbort(err)) {
      this.inflight.delete(job.key);
      job.reject(new AbortedError());
      this.pump();
      return;
    }
    if (err instanceof RateLimitedError) {
      const wait = err.retryAfterMs ?? this.backoff(job.attempt);
      this.pausedUntil = Math.max(this.pausedUntil, now + wait);
      this.requeue(job, err, 0);
      return;
    }
    if ((err instanceof S2Error && err.status >= 500) || err instanceof NetworkError) {
      this.requeue(job, err, this.backoff(job.attempt));
      return;
    }
    this.inflight.delete(job.key);
    job.reject(err);
    this.pump();
  }

  private requeue(job: Job, err: unknown, delay: number): void {
    job.attempt++;
    if (job.attempt > this.opts.maxRetries) {
      this.inflight.delete(job.key);
      job.reject(err);
      this.pump();
      return;
    }
    job.notBefore = Date.now() + delay;
    this.insert(job);
    this.pump();
  }

  private backoff(attempt: number): number {
    const base = this.opts.baseBackoffMs * 2 ** attempt;
    return Math.min(this.opts.maxBackoffMs, base + Math.random() * 250);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
