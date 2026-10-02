import { beforeEach, describe, expect, it } from "bun:test";
import { hmacSha256Hex } from "../../hmac";
import { verifyLinearWebhook } from "./webhook";

function headersWith(signature: string | null): Headers {
  return new Headers(signature === null ? {} : { "linear-signature": signature });
}

function payloadSentAt(webhookTimestamp: number): string {
  return JSON.stringify({ type: "Comment", action: "create", webhookTimestamp });
}

describe("verifyLinearWebhook", () => {
  let body: string;
  let signature: string;

  beforeEach(async () => {
    body = payloadSentAt(Date.now());
    signature = await hmacSha256Hex("s", body);
  });

  describe("the hex digest Linear sends", () => {
    it("accepts the request", async () => {
      expect(await verifyLinearWebhook("s", body, headersWith(signature))).toBe(true);
    });
  });

  describe("a request that does not match the digest", () => {
    it("rejects a changed body", async () => {
      expect(await verifyLinearWebhook("s", `${body} `, headersWith(signature))).toBe(false);
    });

    it("rejects a wrong digest", async () => {
      expect(await verifyLinearWebhook("s", body, headersWith("00"))).toBe(false);
    });

    it("rejects a missing header", async () => {
      expect(await verifyLinearWebhook("s", body, headersWith(null))).toBe(false);
    });
  });

  describe("a correctly signed request Linear sent long ago", () => {
    it("rejects the replay", async () => {
      const replayed = payloadSentAt(Date.now() - 10 * 60 * 1000);
      const replayedSignature = await hmacSha256Hex("s", replayed);
      expect(await verifyLinearWebhook("s", replayed, headersWith(replayedSignature))).toBe(false);
    });
  });
});
