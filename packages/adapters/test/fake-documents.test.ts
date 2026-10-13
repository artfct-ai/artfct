import { describe, expect, it } from "bun:test";
import { FakeDocuments } from "./fake-documents";

describe("FakeDocuments pages", () => {
  it("reads back the text a page was created with", async () => {
    const documents = new FakeDocuments();
    const page = await documents.createPage("Design", "# Design\n\nFirst draft.", "parent-1");
    expect(await documents.readPageContent(page.id)).toBe("# Design\n\nFirst draft.");
  });

  it("gives each created page its own id", async () => {
    const documents = new FakeDocuments();
    const first = await documents.createPage("One", "a", "parent-1");
    const second = await documents.createPage("Two", "b", "parent-1");
    expect(first.id).not.toBe(second.id);
  });

  it("reads the replaced text after an update", async () => {
    const documents = new FakeDocuments();
    const page = await documents.createPage("Design", "old", "parent-1");
    await documents.updatePageContent(page.id, "new");
    expect(await documents.readPageContent(page.id)).toBe("new");
  });

  it("records the title, text, and parent of a create", async () => {
    const documents = new FakeDocuments();
    await documents.createPage("Design", "text", "parent-1");
    expect(documents.argsOf("createPage")).toEqual([["Design", "text", "parent-1"]]);
  });

  it("throws on reading a page it never created", async () => {
    await expect(new FakeDocuments().readPageContent("missing")).rejects.toThrow("missing");
  });

  it("throws on updating a page it never created", async () => {
    await expect(new FakeDocuments().updatePageContent("missing", "x")).rejects.toThrow("missing");
  });
});

describe("FakeDocuments nesting", () => {
  it("holds the title a root page was created with", async () => {
    const documents = new FakeDocuments({ nests: true });
    const page = await documents.nesting?.createRootPage("Ship it", "## Resources", "db-1");
    expect(documents.pageTitle(page?.id ?? "")).toBe("Ship it");
  });

  it("holds the new title after a rename", async () => {
    const documents = new FakeDocuments({ nests: true });
    const page = await documents.nesting?.createRootPage("Ship it", "## Resources", "db-1");
    await documents.nesting?.renamePage(page?.id ?? "", "Ship it (design)");
    expect(documents.pageTitle(page?.id ?? "")).toBe("Ship it (design)");
  });

  it("throws on renaming a page it never created", async () => {
    const documents = new FakeDocuments({ nests: true });
    await expect(documents.nesting?.renamePage("missing", "x")).rejects.toThrow("missing");
  });
});
