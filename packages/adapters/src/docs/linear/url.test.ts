import { describe, expect, it } from "bun:test";
import { linearDocumentSlugFromUrl } from "./url";

const DOC_URL = "https://linear.app/acme/document/design-notes-a1b2c3d4e5f6";

describe("linearDocumentSlugFromUrl", () => {
  it("takes the id after the last dash of the slug", () => {
    expect(linearDocumentSlugFromUrl(DOC_URL)).toBe("a1b2c3d4e5f6");
  });

  it("drops a query string and a fragment", () => {
    expect(linearDocumentSlugFromUrl(`${DOC_URL}?view=full#section`)).toBe("a1b2c3d4e5f6");
  });

  it("drops trailing punctuation", () => {
    expect(linearDocumentSlugFromUrl(`${DOC_URL}.`)).toBe("a1b2c3d4e5f6");
  });

  it("takes a slug that is the id alone", () => {
    expect(linearDocumentSlugFromUrl("https://linear.app/acme/document/a1b2c3d4e5f6")).toBe(
      "a1b2c3d4e5f6",
    );
  });

  it("is null for an issue url", () => {
    expect(linearDocumentSlugFromUrl("https://linear.app/acme/issue/ENG-1/title")).toBeNull();
  });

  it("is null for another host", () => {
    expect(linearDocumentSlugFromUrl("https://www.notion.so/acme/Design-abc")).toBeNull();
  });

  it("is null when the url ends at the document path", () => {
    expect(linearDocumentSlugFromUrl("https://linear.app/acme/document/")).toBeNull();
  });
});
