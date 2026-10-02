import { hmacSha256Hex, timingSafeEqual } from "../../hmac";

const SIGNATURE_HEADER = "x-notion-signature";
const SIGNATURE_PREFIX = "sha256=";

/** Verify a Notion webhook against the raw request body. */
export async function verifyNotionWebhook(
  secret: string,
  body: string,
  headers: Headers,
): Promise<boolean> {
  const signature = headers.get(SIGNATURE_HEADER);
  if (!signature?.startsWith(SIGNATURE_PREFIX)) return false;
  const expected = `${SIGNATURE_PREFIX}${await hmacSha256Hex(secret, body)}`;
  return timingSafeEqual(expected, signature);
}

/**
 * The token from Notion's unsigned subscription handshake, whose body holds nothing else.
 * Null for every other body.
 */
export function notionVerificationToken(body: string): string | null {
  const payload = parseObject(body);
  if (!payload) return null;
  const token = payload.verification_token;
  if (typeof token !== "string" || Object.keys(payload).length !== 1) return null;
  return token;
}

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
