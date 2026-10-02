import { LinearWebhookClient } from "@linear/sdk/webhooks";

const SIGNATURE_HEADER = "linear-signature";

/**
 * Verify a Linear webhook against the raw request body and the timestamp signed inside it. The
 * SDK throws on a mismatch, a body that is not JSON, or a stale timestamp, which reads as false here.
 */
export async function verifyLinearWebhook(
  secret: string,
  body: string,
  headers: Headers,
): Promise<boolean> {
  const signature = headers.get(SIGNATURE_HEADER);
  if (!signature) return false;
  try {
    return new LinearWebhookClient(secret).verify(Buffer.from(body), signature);
  } catch {
    return false;
  }
}
