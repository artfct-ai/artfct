import { describe, expect, it } from "bun:test";
import { linearRequestQuota } from "./rate-limit";

describe("linearRequestQuota", () => {
  it("reads the three request headers", () => {
    const headers = new Headers({
      "x-ratelimit-requests-limit": "5000",
      "x-ratelimit-requests-remaining": "0",
      "x-ratelimit-requests-reset": "1792500000000",
    });
    expect(linearRequestQuota(headers)).toEqual({
      remaining: 0,
      limit: 5000,
      resets_at: 1792500000000,
    });
  });

  it("is null when a header is missing", () => {
    const headers = new Headers({ "x-ratelimit-requests-limit": "5000" });
    expect(linearRequestQuota(headers)).toBeNull();
  });

  it("is null without headers", () => {
    expect(linearRequestQuota(undefined)).toBeNull();
  });
});
