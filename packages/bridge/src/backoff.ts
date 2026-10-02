const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** Reconnect delay for a zero-based attempt number. Doubles each time, capped at 30s. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}
