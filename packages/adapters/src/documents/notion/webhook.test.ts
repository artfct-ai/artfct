import { beforeEach, describe, expect, it } from "bun:test";
import { hmacSha256Hex } from "../../hmac";
import { notionVerificationToken, verifyNotionWebhook } from "./webhook";

function headersWith(signature: string | null): Headers {
  return new Headers(signature === null ? {} : { "x-notion-signature": signature });
}

describe("verifyNotionWebhook", () => {
  let digest: string;

  beforeEach(async () => {
    digest = await hmacSha256Hex("s", "body");
  });

  describe("the sha256 header Notion sends", () => {
    it("accepts the request", async () => {
      expect(await verifyNotionWebhook("s", "body", headersWith(`sha256=${digest}`))).toBe(true);
    });

    it("rejects a changed body", async () => {
      expect(await verifyNotionWebhook("s", "body2", headersWith(`sha256=${digest}`))).toBe(false);
    });
  });

  describe("a header Notion never sends", () => {
    it("rejects a missing header", async () => {
      expect(await verifyNotionWebhook("s", "body", headersWith(null))).toBe(false);
    });

    it("rejects a digest without the prefix", async () => {
      expect(await verifyNotionWebhook("s", "body", headersWith(digest))).toBe(false);
    });
  });
});

describe("notionVerificationToken", () => {
  describe("the subscription handshake body", () => {
    it("reads the token", () => {
      expect(notionVerificationToken(JSON.stringify({ verification_token: "secret_v" }))).toBe(
        "secret_v",
      );
    });
  });

  describe("a body that is not the handshake", () => {
    it("rejects a body carrying more than the token", () => {
      const body = JSON.stringify({ verification_token: "secret_v", type: "comment.created" });
      expect(notionVerificationToken(body)).toBeNull();
    });

    it("rejects a token that is not a string", () => {
      expect(notionVerificationToken(JSON.stringify({ verification_token: 1 }))).toBeNull();
    });

    it("rejects an event body", () => {
      expect(notionVerificationToken(JSON.stringify({ type: "comment.created" }))).toBeNull();
    });

    it("rejects text that is not JSON", () => {
      expect(notionVerificationToken("{nope")).toBeNull();
    });

    it("rejects JSON that is not an object", () => {
      expect(notionVerificationToken("null")).toBeNull();
    });
  });
});
