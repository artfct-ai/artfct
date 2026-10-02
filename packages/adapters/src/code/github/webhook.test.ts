import { sign } from "@octokit/webhooks-methods";
import { beforeEach, describe, expect, it } from "bun:test";
import { verifyGithubWebhook } from "./webhook";

function headersWith(signature: string | null): Headers {
  return new Headers(signature === null ? {} : { "x-hub-signature-256": signature });
}

describe("verifyGithubWebhook", () => {
  let header: string;

  beforeEach(async () => {
    header = await sign("s", "body");
  });

  describe("the header GitHub signs over the body", () => {
    it("accepts the body it signed", async () => {
      expect(await verifyGithubWebhook("s", "body", headersWith(header))).toBe(true);
    });

    it("rejects a changed body", async () => {
      expect(await verifyGithubWebhook("s", "body2", headersWith(header))).toBe(false);
    });

    it("rejects an empty body", async () => {
      expect(await verifyGithubWebhook("s", "", headersWith(header))).toBe(false);
    });
  });

  describe("a header that is missing or malformed", () => {
    let digest: string;

    beforeEach(() => {
      digest = header.slice("sha256=".length);
    });

    it("rejects a missing header instead of throwing", async () => {
      expect(await verifyGithubWebhook("s", "body", headersWith(null))).toBe(false);
    });

    it("rejects a digest with no algorithm prefix", async () => {
      expect(await verifyGithubWebhook("s", "body", headersWith(digest))).toBe(false);
    });

    it("rejects the sha1 prefix", async () => {
      expect(await verifyGithubWebhook("s", "body", headersWith(`sha1=${digest}`))).toBe(false);
    });

    it("rejects text that is no digest at all", async () => {
      expect(await verifyGithubWebhook("s", "body", headersWith("x"))).toBe(false);
    });
  });
});
