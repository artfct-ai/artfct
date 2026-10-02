/** True when a credential that stops working at `expiresAtMs` is within `marginMs` of doing so. */
export function isExpiring(expiresAtMs: number, nowMs: number, marginMs: number): boolean {
  return expiresAtMs - nowMs <= marginMs;
}
