import type { JsonValue } from "@artfct-ai/contracts/types";

/** The most UTF-8 bytes of a vendor event's payload that a firing carries to the agent. */
export const PAYLOAD_CAP_BYTES = 16 * 1024;

/** What ends a payload that was cut at the cap. */
const CUT_MARK = " [cut at 16 KB]";

/**
 * The payload as the agent reads it: compact JSON, cut at the cap with a mark that says so. The cut
 * keeps every character whole.
 */
export function renderedPayload(payload: JsonValue): string {
  const text = JSON.stringify(payload);
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= PAYLOAD_CAP_BYTES) return text;
  const room = PAYLOAD_CAP_BYTES - encoder.encode(CUT_MARK).length;
  let kept = "";
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > room) break;
    kept += character;
    bytes += size;
  }
  return `${kept}${CUT_MARK}`;
}
