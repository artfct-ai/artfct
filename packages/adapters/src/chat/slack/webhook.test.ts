import { beforeEach, describe, expect, it } from "bun:test";
import { hmacSha256Hex } from "../../hmac";
import { isFreshSlackTimestamp, verifySlackWebhook } from "./webhook";

const NOW_MS = 1_700_000_000_000;

function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function signedHeaders(timestamp: string, body: string): Promise<Headers> {
  const signature = `v0=${await hmacSha256Hex("s", `v0:${timestamp}:${body}`)}`;
  return new Headers({ "x-slack-request-timestamp": timestamp, "x-slack-signature": signature });
}

describe("isFreshSlackTimestamp", () => {
  describe("a timestamp inside the five minute window", () => {
    it("accepts the current second", () => {
      expect(isFreshSlackTimestamp(String(NOW_MS / 1000), NOW_MS)).toBe(true);
    });

    it("accepts the oldest second in the window", () => {
      expect(isFreshSlackTimestamp(String(NOW_MS / 1000 - 300), NOW_MS)).toBe(true);
    });

    it("accepts a clock that runs five minutes ahead", () => {
      expect(isFreshSlackTimestamp(String(NOW_MS / 1000 + 300), NOW_MS)).toBe(true);
    });
  });

  describe("a timestamp outside the window", () => {
    it("rejects one second past the window", () => {
      expect(isFreshSlackTimestamp(String(NOW_MS / 1000 - 301), NOW_MS)).toBe(false);
    });

    it("rejects a timestamp from 1970", () => {
      expect(isFreshSlackTimestamp("1", NOW_MS)).toBe(false);
    });
  });
});

describe("verifySlackWebhook", () => {
  describe("a signature over a fresh timestamp and the body", () => {
    let headers: Headers;

    beforeEach(async () => {
      headers = await signedHeaders(freshTimestamp(), "body");
    });

    it("accepts the request", async () => {
      expect(await verifySlackWebhook("s", "body", headers)).toBe(true);
    });

    it("rejects a changed body", async () => {
      expect(await verifySlackWebhook("s", "other", headers)).toBe(false);
    });

    it("rejects a missing timestamp header", async () => {
      headers.delete("x-slack-request-timestamp");
      expect(await verifySlackWebhook("s", "body", headers)).toBe(false);
    });

    it("rejects a missing signature header", async () => {
      headers.delete("x-slack-signature");
      expect(await verifySlackWebhook("s", "body", headers)).toBe(false);
    });
  });

  describe("a signature over a stale timestamp", () => {
    let headers: Headers;

    beforeEach(async () => {
      headers = await signedHeaders("1", "body");
    });

    it("rejects the request although the signature matches", async () => {
      expect(await verifySlackWebhook("s", "body", headers)).toBe(false);
    });
  });
});
