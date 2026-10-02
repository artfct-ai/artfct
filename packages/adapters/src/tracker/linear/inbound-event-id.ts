const encoder = new TextEncoder();

/**
 * Event id for a Linear webhook, from the delivery id. Without one, a hash of the payload
 * keeps the ids distinct.
 */
export async function linearEventId(
  payload: { webhookId?: string },
  deliveryId: string | null,
): Promise<string> {
  if (deliveryId) return `linear:${deliveryId}`;
  const digest = await sha256Hex(JSON.stringify(payload));
  return `linear:${payload.webhookId ?? "webhook"}:${digest.slice(0, 16)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}
