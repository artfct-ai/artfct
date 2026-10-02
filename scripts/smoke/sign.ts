/**
 * Webhook signing for the smoke harness. It repeats `@artfct-ai/adapters/crypto` so the root package
 * keeps no workspace dependency, and so the signer shares no code with the verifier.
 */
const encoder = new TextEncoder();

/** Hex encoded HMAC-SHA256 of `data` under `secret`. */
export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
