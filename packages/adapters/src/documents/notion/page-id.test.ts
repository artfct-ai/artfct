import { describe, expect, it } from "bun:test";
import { notionPageFromUrl, notionPageId } from "./page-id";

const DASHED = "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b";
const BARE = "1f2e3d4c5b6a79889a0b1c2d3e4f5a6b";

describe("notionPageId", () => {
  it("takes an id written with dashes", () => {
    expect(notionPageId(DASHED)).toBe(BARE);
  });

  it("takes an id written without dashes", () => {
    expect(notionPageId(BARE)).toBe(BARE);
  });

  it("takes the id off the end of a page url", () => {
    expect(notionPageId(`https://www.notion.so/acme/Design-${BARE}`)).toBe(BARE);
  });

  it("takes the id off a url that carries a query string", () => {
    expect(notionPageId(`https://www.notion.so/acme/Design-${DASHED}?v=1`)).toBe(BARE);
  });

  it("is null for a url with no page id", () => {
    expect(notionPageId("https://www.notion.so/acme/Design-abc123")).toBeNull();
  });
});

describe("notionPageFromUrl", () => {
  it("takes the page of a workspace url", () => {
    expect(notionPageFromUrl(`https://www.notion.so/acme/Design-${BARE}`)).toEqual({
      page_id: BARE,
    });
  });

  it("takes the page of a url without the www host", () => {
    expect(notionPageFromUrl(`https://notion.so/Design-${DASHED}`)).toEqual({ page_id: BARE });
  });

  it("takes the page of an app url", () => {
    expect(notionPageFromUrl(`https://app.notion.com/p/Design-${BARE}`)).toEqual({
      page_id: BARE,
    });
  });

  it("takes the page of a notion.com workspace url", () => {
    expect(notionPageFromUrl(`https://www.notion.com/acme/Design-${BARE}`)).toEqual({
      page_id: BARE,
    });
  });

  it("takes the page of a published site url", () => {
    expect(notionPageFromUrl(`https://acme.notion.site/Design-${BARE}`)).toEqual({
      page_id: BARE,
    });
  });

  it("is null for a host that only contains the word notion", () => {
    expect(notionPageFromUrl(`https://notion.example.com/Design-${BARE}`)).toBeNull();
  });

  it("is null for a url of another host that ends with an id", () => {
    expect(notionPageFromUrl(`https://example.com/Design-${BARE}`)).toBeNull();
  });

  it("is null for a Notion url with no page id", () => {
    expect(notionPageFromUrl("https://www.notion.so/acme/Design")).toBeNull();
  });
});
