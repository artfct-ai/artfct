import { hmacSha256Hex, timingSafeEqual } from "../../hmac";

const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
const REPLAY_WINDOW_SECONDS = 300;

/** True when a Slack request timestamp (Unix seconds) is within the replay window. */
export function isFreshSlackTimestamp(timestamp: string, nowMs = Date.now()): boolean {
  return Math.abs(nowMs / 1000 - Number(timestamp)) <= REPLAY_WINDOW_SECONDS;
}

/** Verify a Slack webhook against the raw request body. Rejects requests older than five minutes. */
export async function verifySlackWebhook(
  secret: string,
  body: string,
  headers: Headers,
): Promise<boolean> {
  const timestamp = headers.get(TIMESTAMP_HEADER);
  const signature = headers.get(SIGNATURE_HEADER);
  if (!timestamp || !signature) return false;
  if (!isFreshSlackTimestamp(timestamp)) return false;
  const expected = `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`;
  return timingSafeEqual(expected, signature);
}
