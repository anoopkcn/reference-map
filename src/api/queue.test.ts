import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortedError, NetworkError, NotFoundError, RateLimitedError, S2Error } from './errors';
import { RequestQueue } from './queue';

describe('RequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('runs serially with min spacing between starts', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 1000 });
    const starts: number[] = [];
    const mk = (k: string) => q.enqueue(k, async () => {
      starts.push(Date.now());
      return k;
    });
    const p = Promise.all([mk('a'), mk('b'), mk('c')]);
    await flush(0);
    expect(starts).toEqual([0]);
    await flush(999);
    expect(starts).toEqual([0]);
    await flush(1);
    expect(starts).toEqual([0, 1000]);
    await flush(1000);
    expect(starts).toEqual([0, 1000, 2000]);
    expect(await p).toEqual(['a', 'b', 'c']);
  });

  it('respects concurrency and priority', async () => {
    const q = new RequestQueue({ concurrency: 2, minIntervalMs: 0 });
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.enqueue('slow1', async () => {
      order.push('slow1');
      await gate;
    });
    q.enqueue('slow2', async () => {
      order.push('slow2');
      await gate;
    });
    q.enqueue('low', async () => void order.push('low'), { priority: 0 });
    q.enqueue('high', async () => void order.push('high'), { priority: 5 });
    await flush(0);
    expect(order).toEqual(['slow1', 'slow2']);
    release();
    await flush(0);
    expect(order).toEqual(['slow1', 'slow2', 'high', 'low']);
  });

  it('dedupes identical keys while in flight', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    let calls = 0;
    const run = async () => {
      calls++;
      return 42;
    };
    const a = q.enqueue('k', run);
    const b = q.enqueue('k', run);
    expect(a).toBe(b);
    await flush(0);
    expect(await a).toBe(42);
    expect(calls).toBe(1);
    // after completion a new request is issued
    q.enqueue('k', run);
    await flush(0);
    expect(calls).toBe(2);
  });

  it('pauses globally on 429 and honours Retry-After', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, baseBackoffMs: 100 });
    let attempts = 0;
    const p = q.enqueue('k', async () => {
      attempts++;
      if (attempts === 1) throw new RateLimitedError(2000);
      return 'ok';
    });
    const other: number[] = [];
    q.enqueue('other', async () => void other.push(Date.now()));
    await flush(0);
    expect(attempts).toBe(1);
    expect(q.status().pausedUntil).toBe(2000);
    await flush(1999);
    expect(attempts).toBe(1);
    expect(other).toEqual([]);
    await flush(1);
    expect(attempts).toBe(2);
    expect(await p).toBe('ok');
    await flush(0);
    expect(other).toEqual([2000]);
  });

  it('backs off exponentially on 5xx / network errors, capped, and gives up after maxRetries', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic jitter
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0, baseBackoffMs: 100, maxBackoffMs: 350, maxRetries: 3 });
    const starts: number[] = [];
    const p = q.enqueue('k', async () => {
      starts.push(Date.now());
      if (starts.length % 2) throw new S2Error(503, 'boom');
      throw new NetworkError();
    });
    p.catch(() => {});
    await flush(0);
    expect(starts).toEqual([0]);
    await flush(99);
    expect(starts.length).toBe(1);
    await flush(1); // attempt 0 backoff: 100
    expect(starts).toEqual([0, 100]);
    await flush(200); // attempt 1 backoff: 200
    expect(starts).toEqual([0, 100, 300]);
    await flush(350); // attempt 2 backoff: min(350, 400) — capped
    expect(starts).toEqual([0, 100, 300, 650]);
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    await flush(10_000);
    expect(starts.length).toBe(4);
    rnd.mockRestore();
  });

  it('does not retry 404 / 400', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    let n = 0;
    const p = q.enqueue('k', async () => {
      n++;
      throw new NotFoundError();
    });
    await expect(p).rejects.toBeInstanceOf(NotFoundError);
    await flush(5000);
    expect(n).toBe(1);
  });

  it('abort: removes a pending job; with two subscribers only aborting both cancels', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 1000 });
    q.enqueue('first', async () => 'x');
    const c1 = new AbortController();
    const c2 = new AbortController();
    let ran = false;
    const p1 = q.enqueue('k', async () => (ran = true), { signal: c1.signal });
    const p2 = q.enqueue('k', async () => (ran = true), { signal: c2.signal });
    p1.catch(() => {});
    await flush(0);
    c1.abort();
    expect(q.status().pending).toBe(1);
    c2.abort();
    expect(q.status().pending).toBe(0);
    await expect(p2).rejects.toBeInstanceOf(AbortedError);
    await flush(5000);
    expect(ran).toBe(false);
  });

  it('abort: an in-flight job receives the signal and rejects with AbortedError', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    const c = new AbortController();
    let seenAbort = false;
    const p = q.enqueue(
      'k',
      (signal) =>
        new Promise((_, rej) => {
          signal.addEventListener('abort', () => {
            seenAbort = true;
            rej(new DOMException('x', 'AbortError'));
          });
        }),
      { signal: c.signal },
    );
    await flush(0);
    c.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(seenAbort).toBe(true);
    expect(q.status().active).toBe(0);
  });

  it('reports status changes', async () => {
    const q = new RequestQueue({ concurrency: 1, minIntervalMs: 0 });
    const seen: number[] = [];
    q.onStatus((s) => seen.push(s.pending + s.active));
    q.enqueue('a', async () => 1);
    q.enqueue('b', async () => 2);
    await flush(0);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(0);
  });
});
