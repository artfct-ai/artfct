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
  let out = "";
  for (const byte of new Uint8Array(signature)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Compare two strings in constant time. Use for signatures and tokens. */
export function timingSafeEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}
