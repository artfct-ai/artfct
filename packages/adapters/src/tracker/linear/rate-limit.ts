import type { RequestQuota } from "../types";

/**
 * The request quota Linear names in the rate limit headers of an answer. Null when an answer
 * leaves one out.
 */
export function linearRequestQuota(headers: Headers | undefined): RequestQuota | null {
  if (!headers) return null;
  const remaining = Number(headers.get("x-ratelimit-requests-remaining") ?? Number.NaN);
  const limit = Number(headers.get("x-ratelimit-requests-limit") ?? Number.NaN);
  const resetsAt = Number(headers.get("x-ratelimit-requests-reset") ?? Number.NaN);
  if (![remaining, limit, resetsAt].every(Number.isFinite)) return null;
  return { remaining, limit, resets_at: resetsAt };
}
