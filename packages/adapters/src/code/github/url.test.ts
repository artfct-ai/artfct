import { describe, expect, it } from "bun:test";
import { githubCloneUrl, githubPullFromUrl, githubPullUrl } from "./url";

describe("githubPullFromUrl", () => {
  it("reads the repo and the number from a pull request link", () => {
    expect(githubPullFromUrl("https://github.com/acme/app/pull/12")).toEqual({
      repo: "acme/app",
      number: 12,
    });
  });

  it("reads a pull request link that carries a tab and a fragment", () => {
    expect(githubPullFromUrl("https://github.com/acme/app/pull/12/files#r1")).toEqual({
      repo: "acme/app",
      number: 12,
    });
  });

  it("is null for a link that is not a pull request", () => {
    expect(githubPullFromUrl("https://github.com/acme/app/issues/12")).toBeNull();
  });

  it("is null for a link that is not GitHub", () => {
    expect(githubPullFromUrl("https://example.com/nope")).toBeNull();
  });
});

describe("githubPullUrl", () => {
  it("writes the link a repo and a number name", () => {
    expect(githubPullUrl({ repo: "acme/app", number: 12 })).toBe(
      "https://github.com/acme/app/pull/12",
    );
  });

  it("writes what githubPullFromUrl reads back", () => {
    const pull = { repo: "acme/app", number: 12 };
    expect(githubPullFromUrl(githubPullUrl(pull))).toEqual(pull);
  });
});

describe("githubCloneUrl", () => {
  it("writes the https clone link of a repository", () => {
    expect(githubCloneUrl("acme/app")).toBe("https://github.com/acme/app.git");
  });

  it("carries no credential", () => {
    expect(githubCloneUrl("acme/app")).not.toContain("@");
  });
});
