import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeLinear, PAGE, type Call } from "../../../test/linear-graphql";
import { LinearDocuments } from "./documents";
import type { DocumentComment, DocumentPage, FetchedComment } from "../types";

afterEach(() => mock.restore());

describe("LinearDocuments document", () => {
  let calls: Call[];
  let page: DocumentPage | null;

  beforeEach(async () => {
    calls = fakeLinear({
      document: {
        document: {
          id: "d1",
          documentContentId: "dc1",
          url: "https://l/doc",
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      },
    });
    page = await new LinearDocuments("lin_api_x").document("abc");
  });

  it("asks for the id or slug it was given", () => {
    expect(calls[0]?.variables).toEqual({ id: "abc" });
  });

  it("maps the id, content id, url, and revision", () => {
    expect(page).toEqual({
      id: "d1",
      contentId: "dc1",
      url: "https://l/doc",
      revision: "2026-09-02T00:00:00.000Z",
    });
  });
});

it("reads a missing content id as null", async () => {
  fakeLinear({
    document: { document: { id: "d1", url: "https://l/doc", updatedAt: "2026-09-02T00:00:00Z" } },
  });
  expect((await new LinearDocuments("lin_api_x").document("d1"))?.contentId).toBeNull();
});

describe("LinearDocuments page", () => {
  let calls: Call[];
  let page: DocumentPage | null;

  beforeEach(async () => {
    calls = fakeLinear({
      PageByContentId: {
        comments: {
          nodes: [
            {
              documentContent: {
                id: "dc1",
                updatedAt: "2026-09-03T00:00:00.000Z",
                document: { id: "d1", url: "https://l/doc" },
              },
            },
          ],
        },
      },
    });
    page = await new LinearDocuments("lin_api_x").page("dc1");
  });

  it("filters comments by the document content id", () => {
    expect(calls[0]?.variables).toEqual({ contentId: "dc1" });
  });

  it("maps the document id and url with the content revision", () => {
    expect(page).toEqual({
      id: "d1",
      contentId: "dc1",
      url: "https://l/doc",
      revision: "2026-09-03T00:00:00.000Z",
    });
  });
});

it("page is null when the document has no comment yet", async () => {
  fakeLinear({ PageByContentId: { comments: { nodes: [] } } });
  expect(await new LinearDocuments("lin_api_x").page("dc1")).toBeNull();
});

it("document is null when the document is gone", async () => {
  fakeLinear({ document: { errors: [{ message: "Entity not found: Document" }] } });
  expect(await new LinearDocuments("lin_api_x").document("gone")).toBeNull();
});

describe("LinearDocuments pageRemoved", () => {
  const url = "https://linear.app/acme/document/design-abc123";

  it("is false for a document Linear still holds", async () => {
    fakeLinear({ document: { document: { id: "d1", trashed: false } } });
    expect(await new LinearDocuments("lin_api_x").pageRemoved(url)).toBe(false);
  });

  it("is true for a document in the trash", async () => {
    fakeLinear({ document: { document: { id: "d1", trashed: true } } });
    expect(await new LinearDocuments("lin_api_x").pageRemoved(url)).toBe(true);
  });

  it("is true for a document Linear no longer finds", async () => {
    fakeLinear({ document: { errors: [{ message: "Entity not found: Document" }] } });
    expect(await new LinearDocuments("lin_api_x").pageRemoved(url)).toBe(true);
  });

  it("is false for a URL of another host", async () => {
    fakeLinear({});
    expect(await new LinearDocuments("lin_api_x").pageRemoved("https://example.com/x")).toBe(false);
  });
});

it("comment addresses the document content id", async () => {
  const calls = fakeLinear({
    createComment: { commentCreate: { success: true, comment: { id: "c1" } } },
  });
  await new LinearDocuments("lin_api_x").comment("dc1", "looks good");
  expect(calls[0]?.variables.input).toEqual({ documentContentId: "dc1", body: "looks good" });
});

describe("LinearDocuments acknowledgeComment", () => {
  let calls: Call[];

  beforeEach(async () => {
    calls = fakeLinear({
      createReaction: { reactionCreate: { success: true, reaction: { id: "r1" } } },
    });
    await new LinearDocuments("lin_api_x").acknowledgeComment({ pageId: "dc1", commentId: "c1" });
  });

  it("sends one reaction and no reply", () => {
    expect(calls.map((call) => call.operation)).toEqual(["createReaction"]);
  });

  it("puts an eyes reaction on the comment", () => {
    expect(calls[0]?.variables.input).toEqual({ commentId: "c1", emoji: "eyes" });
  });
});

const MENTION_BODY_DATA = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "suggestion_userMentions", attrs: { id: "app1", label: "artfct" } },
        { type: "text", text: " please revise" },
      ],
    },
  ],
});

const linearComment = (overrides: Record<string, unknown> = {}) => ({
  comment: {
    id: "c1",
    body: "@artfct please revise",
    bodyData: MENTION_BODY_DATA,
    resolvedAt: null,
    user: { id: "u1", name: "Ann Lee", email: "ann@x.y" },
    ...overrides,
  },
});

describe("LinearDocuments fetchComment", () => {
  let calls: Call[];
  let comment: FetchedComment | null;

  beforeEach(async () => {
    calls = fakeLinear({ CommentWithBodyData: linearComment() });
    comment = await new LinearDocuments("lin_api_x").fetchComment("c1");
  });

  it("asks for the comment by id with its body data", () => {
    expect(calls[0]?.variables).toEqual({ id: "c1" });
    expect(calls[0]?.query).toContain("bodyData");
  });

  it("maps the body, the author, and the users the body data mentions", () => {
    expect(comment).toEqual({
      text: "@artfct please revise",
      author: { id: "u1", email: "ann@x.y" },
      mentions: ["app1"],
    });
  });
});

it("fetchComment has no author when the comment carries none", async () => {
  fakeLinear({ CommentWithBodyData: linearComment({ user: null }) });
  const comment = await new LinearDocuments("lin_api_x").fetchComment("c1");
  expect(comment?.author).toBeNull();
});

it("fetchComment is null for a comment in a resolved thread", async () => {
  fakeLinear({ CommentWithBodyData: linearComment({ resolvedAt: "2026-09-30T00:00:00.000Z" }) });
  expect(await new LinearDocuments("lin_api_x").fetchComment("c1")).toBeNull();
});

it("fetchComment is null for a deleted comment", async () => {
  fakeLinear({ CommentWithBodyData: { errors: [{ message: "Entity not found: Comment" }] } });
  expect(await new LinearDocuments("lin_api_x").fetchComment("c1")).toBeNull();
});

const node = (id: string, createdAt: string, userId: string) => ({
  id,
  body: `said in ${id}`,
  createdAt,
  reactions: [],
  user: { id: userId },
});

describe("LinearDocuments comments", () => {
  let calls: Call[];
  let comments: DocumentComment[];

  beforeEach(async () => {
    calls = fakeLinear({
      comments: {
        comments: {
          pageInfo: PAGE,
          nodes: [
            node("c2", "2026-09-02T00:00:00.000Z", "u2"),
            node("c1", "2026-09-01T00:00:00.000Z", "u1"),
          ],
        },
      },
    });
    comments = await new LinearDocuments("lin_api_x").comments("dc1", "2026-09-01T00:00:00.000Z");
  });

  it("filters by the document content id and the time", () => {
    expect(calls[0]?.variables.filter).toEqual({
      documentContent: { id: { eq: "dc1" } },
      createdAt: { gte: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("maps each comment oldest first", () => {
    expect(comments).toEqual([
      {
        id: "c1",
        created_at: "2026-09-01T00:00:00.000Z",
        text: "said in c1",
        author: { id: "u1", email: null },
      },
      {
        id: "c2",
        created_at: "2026-09-02T00:00:00.000Z",
        text: "said in c2",
        author: { id: "u2", email: null },
      },
    ]);
  });
});

it("reads a comment without a user as having no author", async () => {
  fakeLinear({
    comments: {
      comments: {
        pageInfo: PAGE,
        nodes: [{ id: "c1", body: "hi", createdAt: "2026-09-01T00:00:00.000Z", reactions: [] }],
      },
    },
  });
  const comments = await new LinearDocuments("lin_api_x").comments("dc1", "2026-09-01T00:00:00Z");
  expect(comments[0]?.author).toBeNull();
});

const commentNode = (id: string, userId: string | null, reactions: unknown[] = []) => ({
  id,
  body: `said ${id}`,
  resolvedAt: null,
  parent: null,
  user: userId ? { id: userId, name: userId === "app1" ? "artfct" : "Ann" } : null,
  reactions,
});

describe("LinearDocuments heldComments", () => {
  const viewer = { viewer: { id: "app1", email: "app@x.y", displayName: "artfct" } };
  const firstPage = {
    comments: {
      nodes: [
        commentNode("c1", "u1"),
        commentNode("c2", "u1", [{ emoji: "eyes", user: { id: "app1" } }]),
        commentNode("c3", "app1"),
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor1" },
    },
  };
  const secondPage = {
    comments: {
      nodes: [commentNode("c4", "u1", [{ emoji: "eyes", user: { id: "u2" } }])],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  let calls: Call[];
  let held: Awaited<ReturnType<LinearDocuments["heldComments"]>>;

  beforeEach(async () => {
    calls = fakeLinear({
      viewer,
      DocumentCommentsWithReactions: (call) => (call.variables.after ? secondPage : firstPage),
    });
    held = await new LinearDocuments("lin_api_x").heldComments("dc1");
  });

  it("asks for the comments on the content id with their reactions, page by page", () => {
    const queries = calls.filter((call) => call.operation === "DocumentCommentsWithReactions");
    expect(queries.map((call) => call.variables)).toEqual([
      { contentId: "dc1", after: null },
      { contentId: "dc1", after: "cursor1" },
    ]);
    expect(queries[0]?.query).toContain("reactions { emoji user { id } }");
  });

  it("holds a person's comment without the bot's eyes reaction", () => {
    expect(held).toEqual([
      { id: "c1", author_name: "Ann", text: "said c1" },
      { id: "c4", author_name: "Ann", text: "said c4" },
    ]);
  });
});

it("heldComments skips integration comments and resolved threads", async () => {
  fakeLinear({
    viewer: { viewer: { id: "app1", email: "app@x.y", displayName: "artfct" } },
    DocumentCommentsWithReactions: {
      comments: {
        nodes: [
          { id: "c1", body: "bot", resolvedAt: null, parent: null, user: null, reactions: [] },
          {
            id: "c2",
            body: "done",
            resolvedAt: "2026-09-02T00:00:00.000Z",
            parent: null,
            user: { id: "u1", name: "Ann" },
            reactions: [],
          },
          {
            id: "c3",
            body: "reply",
            resolvedAt: null,
            parent: { resolvedAt: "2026-09-02T00:00:00.000Z" },
            user: { id: "u1", name: "Ann" },
            reactions: [],
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
  expect(await new LinearDocuments("lin_api_x").heldComments("dc1")).toEqual([]);
});

it("self reads the viewer of the token and the display name a mention shows", async () => {
  const calls = fakeLinear({
    viewer: { viewer: { id: "app1", email: "app@x.y", displayName: "artfct" } },
  });
  expect(await new LinearDocuments("lin_api_x").self()).toEqual({ id: "app1", name: "artfct" });
  expect(calls[0]?.operation).toBe("viewer");
});

it("userEmail asks for the user it was given", async () => {
  const calls = fakeLinear({ user: { user: { id: "u1", email: "ann@x.y" } } });
  expect(await new LinearDocuments("lin_api_x").userEmail("u1")).toBe("ann@x.y");
  expect(calls[0]?.variables).toEqual({ id: "u1" });
});

const documentNode = (id: string, contentId: string) => ({
  id,
  documentContentId: contentId,
  content: `text of ${id}`,
  url: `https://l/${id}`,
  updatedAt: "2026-09-04T00:00:00.000Z",
});

describe("LinearDocuments createPage", () => {
  let calls: Call[];
  let page: DocumentPage;

  beforeEach(async () => {
    calls = fakeLinear({
      createDocument: { documentCreate: { success: true, lastSyncId: 1, document: { id: "d1" } } },
      document: { document: documentNode("d1", "dc1") },
    });
    page = await new LinearDocuments("lin_api_x").createPage("Design", "# Design", "proj1");
  });

  it("creates the document with its title and content in the parent project", () => {
    expect(calls[0]?.operation).toBe("createDocument");
    expect(calls[0]?.variables.input).toEqual({
      title: "Design",
      content: "# Design",
      projectId: "proj1",
    });
  });

  it("maps the created document", () => {
    expect(page).toEqual({
      id: "d1",
      contentId: "dc1",
      url: "https://l/d1",
      revision: "2026-09-04T00:00:00.000Z",
    });
  });
});

describe("LinearDocuments readPageContent", () => {
  let calls: Call[];
  let text: string;

  beforeEach(async () => {
    calls = fakeLinear({
      documents: (call) =>
        call.variables.after === "cursor1"
          ? { documents: { pageInfo: PAGE, nodes: [documentNode("d2", "dc2")] } }
          : {
              documents: {
                pageInfo: { ...PAGE, hasNextPage: true, endCursor: "cursor1" },
                nodes: [documentNode("d1", "dc1")],
              },
            },
    });
    text = await new LinearDocuments("lin_api_x").readPageContent("dc2");
  });

  it("pages through the documents until the content id matches", () => {
    expect(calls.map((call) => call.variables.after ?? null)).toEqual([null, "cursor1"]);
  });

  it("returns the content of the matching document", () => {
    expect(text).toBe("text of d2");
  });
});

it("readPageContent throws when no document has the content id", async () => {
  fakeLinear({ documents: { documents: { pageInfo: PAGE, nodes: [documentNode("d1", "dc1")] } } });
  await expect(new LinearDocuments("lin_api_x").readPageContent("dc9")).rejects.toThrow("dc9");
});

describe("LinearDocuments updatePageContent", () => {
  let calls: Call[];

  beforeEach(async () => {
    calls = fakeLinear({
      documents: { documents: { pageInfo: PAGE, nodes: [documentNode("d1", "dc1")] } },
      updateDocument: { documentUpdate: { success: true, lastSyncId: 2, document: { id: "d1" } } },
    });
    await new LinearDocuments("lin_api_x").updatePageContent("dc1", "# Revised");
  });

  it("updates the document the content id resolves to", () => {
    expect(calls[1]?.operation).toBe("updateDocument");
    expect(calls[1]?.variables).toEqual({ id: "d1", input: { content: "# Revised" } });
  });
});
