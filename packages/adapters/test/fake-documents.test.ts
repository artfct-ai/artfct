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
    await documents.updatePageContent(page.id, { before: "old", after: "new" });
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
    const change = { before: "x", after: "y" };
    await expect(new FakeDocuments().updatePageContent("missing", change)).rejects.toThrow(
      "missing",
    );
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

describe("FakeDocuments lines and comments", () => {
  const before = "# Goal\nShip it.\n## Risks\nNone yet.";

  function secondLineId(documents: FakeDocuments, pageId: string): number {
    const lineId = documents.lineIds(pageId)[1];
    if (lineId === undefined) throw new Error("the page has one line");
    return lineId;
  }

  async function seeded() {
    const documents = new FakeDocuments();
    const page = await documents.createPage("Design", before, "parent-1");
    return { documents, pageId: page.id };
  }

  it("keeps the ids of the lines an update does not cover", async () => {
    const { documents, pageId } = await seeded();
    const [goal, ship, risks, none] = documents.lineIds(pageId);
    const after = "# Goal\nShip it today.\n## Risks\nNone yet.";
    await documents.updatePageContent(pageId, { before, after });
    const now = documents.lineIds(pageId);
    expect([now[0], now[2], now[3]]).toEqual([goal, risks, none]);
    expect(now[1]).not.toBe(ship);
  });

  it("records the lines an update removed", async () => {
    const { documents, pageId } = await seeded();
    const ship = secondLineId(documents, pageId);
    await documents.updatePageContent(pageId, {
      before,
      after: "# Goal\n## Risks\nNone yet.",
    });
    expect(documents.events).toEqual([{ kind: "lines_removed", pageId, lineIds: [ship] }]);
  });

  it("holds a person comment until its line is gone", async () => {
    const { documents, pageId } = await seeded();
    const ship = secondLineId(documents, pageId);
    documents.addPersonComment({ id: "c1", pageId, lineId: ship, authorName: "Ann", text: "Why?" });
    expect((await documents.heldComments(pageId)).map((comment) => comment.id)).toEqual(["c1"]);
    await documents.updatePageContent(pageId, { before, after: "# Goal\n## Risks\nNone yet." });
    expect(await documents.heldComments(pageId)).toEqual([]);
  });

  it("records a reply to an open comment", async () => {
    const { documents, pageId } = await seeded();
    documents.addPersonComment({ id: "c1", pageId, lineId: null, authorName: "Ann", text: "Why?" });
    await documents.replyToComment({ pageId, commentId: "c1" }, "Because.");
    expect(documents.events).toEqual([{ kind: "reply", commentId: "c1", text: "Because." }]);
  });

  it("fails a reply to a comment whose line is gone", async () => {
    const { documents, pageId } = await seeded();
    const ship = secondLineId(documents, pageId);
    documents.addPersonComment({ id: "c1", pageId, lineId: ship, authorName: "Ann", text: "Why?" });
    await documents.updatePageContent(pageId, { before, after: "# Goal\n## Risks\nNone yet." });
    await expect(documents.replyToComment({ pageId, commentId: "c1" }, "Because.")).rejects.toThrow(
      "gone",
    );
  });

  it("fails the next call of a method once, and changes nothing", async () => {
    const { documents, pageId } = await seeded();
    documents.failNext("updatePageContent");
    const change = { before, after: "# Goal" };
    await expect(documents.updatePageContent(pageId, change)).rejects.toThrow("host outage");
    expect(documents.pageText(pageId)).toBe(before);
    await documents.updatePageContent(pageId, change);
    expect(documents.pageText(pageId)).toBe("# Goal");
  });

  it("keeps the page when an edit does not match the page", async () => {
    const { documents, pageId } = await seeded();
    const change = { before: "# Goal\nShip it later.", after: "# Goal\nShip it now." };
    await expect(documents.updatePageContent(pageId, change)).rejects.toThrow("once");
    expect(documents.pageText(pageId)).toBe(before);
  });
});

describe("FakeDocuments comments", () => {
  const onPage = { passage: "first  **draft**", text: "Name the owner." };
  const elsewhere = { passage: "a passage the page lacks", text: "Elsewhere." };

  async function commented(commenting: FakeDocuments["commenting"]) {
    const documents = new FakeDocuments();
    documents.seedPage("p1", "# Design\n\nFirst draft.");
    documents.commenting = commenting;
    const unposted = await documents
      .commentOnPassages("p1", [onPage, elsewhere])
      .catch((error: Error) => error.message);
    return { documents, unposted };
  }

  it("posts a comment whose passage the page holds and returns the rest", async () => {
    const { documents, unposted } = await commented("takes");
    expect(unposted).toEqual([elsewhere]);
    expect(documents.postedComments).toEqual([{ pageId: "p1", ...onPage }]);
  });

  it("returns every passage comment when it drops them", async () => {
    const { documents, unposted } = await commented("drops_inline");
    expect(unposted).toEqual([onPage, elsewhere]);
    expect(documents.postedComments).toEqual([]);
  });

  it("throws on passage comments when they fail", async () => {
    expect((await commented("inline_throws")).unposted).toContain("the host is down");
  });

  it("takes a page comment unless the host is down", async () => {
    const documents = new FakeDocuments();
    await documents.comment("p1", "Review: approved");
    documents.commenting = "down";
    await expect(documents.comment("p1", "Review: approved")).rejects.toThrow("down");
    expect(documents.postedComments).toEqual([
      { pageId: "p1", passage: null, text: "Review: approved" },
    ]);
  });
});
