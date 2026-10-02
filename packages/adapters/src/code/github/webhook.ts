import { verify } from "@octokit/webhooks-methods";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/i;

/**
 * Verify a GitHub webhook against the raw request body. A missing or malformed signature
 * header is a plain `false`, never a throw.
 */
export async function verifyGithubWebhook(
  secret: string,
  body: string,
  headers: Headers,
): Promise<boolean> {
  const signature = headers.get(SIGNATURE_HEADER);
  if (!signature || !SIGNATURE_PATTERN.test(signature) || body === "") return false;
  return verify(secret, body, signature);
}
