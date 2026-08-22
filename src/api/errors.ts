export class S2Error extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'S2Error';
    this.status = status;
    this.body = body;
  }
}

export class NotFoundError extends S2Error {
  constructor(message = 'Not found', body?: unknown) {
    super(404, message, body);
    this.name = 'NotFoundError';
  }
}

export class RateLimitedError extends S2Error {
  /** Parsed Retry-After in ms, if the server sent one. */
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null, message = 'Rate limited', body?: unknown) {
    super(429, message, body);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network error') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class AbortedError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof AbortedError || (e instanceof Error && e.name === 'AbortError');
}

/** User-facing message for any error thrown by the API layer. */
export function describeError(e: unknown): string {
  if (e instanceof NotFoundError) return 'Not found on Semantic Scholar';
  if (e instanceof RateLimitedError) return 'Rate limited by Semantic Scholar — retrying';
  if (e instanceof S2Error) return `Semantic Scholar error (${e.status})`;
  if (e instanceof NetworkError) return 'Could not reach Semantic Scholar (network error or service temporarily unavailable) — try again in a moment';
  if (isAbort(e)) return 'Cancelled';
  if (e instanceof Error) return e.message || 'Unknown error';
  return String(e);
}
