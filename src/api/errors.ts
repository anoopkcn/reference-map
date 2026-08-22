import { PROVIDER_LABEL, type ProviderId } from '../types';

/** HTTP-level error from any provider. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly provider: ProviderId | undefined;
  constructor(status: number, message: string, body?: unknown, provider?: ProviderId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.provider = provider;
  }
}
/** @deprecated alias kept for older call sites/tests. */
export { ApiError as S2Error };

export class NotFoundError extends ApiError {
  constructor(message = 'Not found', body?: unknown, provider?: ProviderId) {
    super(404, message, body, provider);
    this.name = 'NotFoundError';
  }
}

export class RateLimitedError extends ApiError {
  /** Parsed Retry-After in ms, if the server sent one. */
  readonly retryAfterMs: number | null;
  constructor(retryAfterMs: number | null, message = 'Rate limited', body?: unknown, provider?: ProviderId) {
    super(429, message, body, provider);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class NetworkError extends Error {
  readonly provider: ProviderId | undefined;
  constructor(message = 'Network error', provider?: ProviderId) {
    super(message);
    this.name = 'NetworkError';
    this.provider = provider;
  }
}

/** The selected provider(s) cannot handle this kind of identifier (e.g. arXiv ids on OpenAlex). */
export class UnsupportedLookupError extends Error {
  readonly lookup: string;
  readonly provider: ProviderId | undefined;
  constructor(lookup: string, provider?: ProviderId) {
    super(provider ? `${PROVIDER_LABEL[provider]} cannot look up "${lookup}"` : `No data source can look up "${lookup}"`);
    this.name = 'UnsupportedLookupError';
    this.lookup = lookup;
    this.provider = provider;
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

function who(p: ProviderId | undefined): string {
  return p ? PROVIDER_LABEL[p] : 'the data sources';
}

/** User-facing message for any error thrown by the API layer. */
export function describeError(e: unknown): string {
  if (e instanceof UnsupportedLookupError) return e.message;
  if (e instanceof NotFoundError) return e.provider ? `Not found on ${PROVIDER_LABEL[e.provider]}` : 'Not found on Semantic Scholar or OpenAlex';
  if (e instanceof RateLimitedError) return `Rate limited by ${who(e.provider)} — retrying`;
  if (e instanceof ApiError) return `${who(e.provider)} error (${e.status})`;
  if (e instanceof NetworkError) return `Could not reach ${who(e.provider)} (network error or service temporarily unavailable) — try again in a moment`;
  if (isAbort(e)) return 'Cancelled';
  if (e instanceof Error) return e.message || 'Unknown error';
  return String(e);
}
