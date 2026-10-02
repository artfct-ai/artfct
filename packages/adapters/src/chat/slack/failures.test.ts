import {
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { describe, expect, it } from "bun:test";
import { describeSlackFailure } from "./failures";

function platformError(code: string): WebAPIPlatformError {
  return new WebAPIPlatformError({ ok: false, error: code });
}

describe("describeSlackFailure", () => {
  describe("a platform error Slack names", () => {
    it("asks a human to invite the bot when it is not in the channel", () => {
      expect(describeSlackFailure(platformError("not_in_channel"))).toBe(
        "the bot is not a member of that channel. A human has to invite it there before it can read.",
      );
    });

    it("asks an admin to add a scope the app is missing", () => {
      expect(describeSlackFailure(platformError("missing_scope"))).toContain("An admin has to add");
    });

    it("says Slack has no thread at that timestamp", () => {
      expect(describeSlackFailure(platformError("thread_not_found"))).toBe(
        "Slack has no thread at that timestamp.",
      );
    });

    it("asks the caller to read the page again on a stale cursor", () => {
      expect(describeSlackFailure(platformError("invalid_cursor"))).toContain(
        "Read the page again",
      );
    });

    it("names an unknown code as is", () => {
      expect(describeSlackFailure(platformError("something_new"))).toBe(
        "Slack refused the call: something_new.",
      );
    });
  });

  describe("a rate limit", () => {
    it("says how long to wait", () => {
      expect(describeSlackFailure(new WebAPIRateLimitedError(45))).toBe(
        "Slack rate limited this call. Try again in 45 seconds.",
      );
    });
  });

  describe("a call that never reached a Slack result", () => {
    it("names the status of an HTTP failure", () => {
      expect(describeSlackFailure(new WebAPIHTTPError(503, "Unavailable", {}, ""))).toBe(
        "Slack answered HTTP 503 instead of a result.",
      );
    });

    it("names the cause of a request failure", () => {
      expect(describeSlackFailure(new WebAPIRequestError(new Error("socket hang up")))).toBe(
        "Slack could not be reached: socket hang up",
      );
    });
  });

  describe("any other error", () => {
    it("falls back to the text of the error", () => {
      expect(describeSlackFailure(new Error("boom"))).toBe("Slack failed: Error: boom");
    });

    it("clips a long text at 200 characters", () => {
      expect(describeSlackFailure("x".repeat(300))).toHaveLength("Slack failed: ".length + 200);
    });
  });
});
