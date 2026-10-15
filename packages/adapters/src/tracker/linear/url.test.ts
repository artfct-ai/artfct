import { describe, expect, it } from "bun:test";
import { linearIssueKeyFromUrl, linearProjectSlugFromUrl } from "./url";

const DOC_URL = "https://linear.app/acme/document/design-notes-a1b2c3d4e5f6";

describe("linearIssueKeyFromUrl", () => {
  it("reads the identifier from an issue url", () => {
    expect(linearIssueKeyFromUrl("https://linear.app/acme/issue/ENG-42/fix-login")).toBe("ENG-42");
  });

  it("reads an identifier with no slug after it", () => {
    expect(linearIssueKeyFromUrl("https://linear.app/acme/issue/ENG-42")).toBe("ENG-42");
  });

  it("is null for a document url", () => {
    expect(linearIssueKeyFromUrl(DOC_URL)).toBeNull();
  });

  it("is null for another host", () => {
    expect(linearIssueKeyFromUrl("https://github.com/acme/app/pull/1")).toBeNull();
  });
});

describe("linearProjectSlugFromUrl", () => {
  it("reads the slug id from a project url", () => {
    expect(
      linearProjectSlugFromUrl("https://linear.app/acme/project/checkout-revamp-0a1b2c3d4e5f"),
    ).toBe("0a1b2c3d4e5f");
  });

  it("reads the slug id from a project url with a tab after it", () => {
    expect(
      linearProjectSlugFromUrl(
        "https://linear.app/acme/project/checkout-revamp-0a1b2c3d4e5f/overview",
      ),
    ).toBe("0a1b2c3d4e5f");
  });

  it("is null for an issue url", () => {
    expect(linearProjectSlugFromUrl("https://linear.app/acme/issue/ENG-42/fix-login")).toBeNull();
  });
});
