import { Client } from "@notionhq/client";
import { beforeEach, describe, expect, it } from "bun:test";
import { fetchBody, fetchHeader, fetchUrl } from "../../../test/fetch";
import type { DocumentPage, FetchedComment } from "../types";
import { NotionDocuments } from "./documents";

type Call = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  version: string | null;
  body: string;
};

function notionDocuments(respond: (url: string) => Response, baseUrl?: string) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: fetchUrl(input),
      method: init?.method ?? "GET",
      authorization: fetchHeader(init, "authorization"),
      contentType: fetchHeader(init, "content-type"),
      version: fetchHeader(init, "notion-version"),
      body: fetchBody(init),
    });
    return respond(fetchUrl(input));
  };
  return { documents: new NotionDocuments("secret_x", { fetch, baseUrl }), calls };
}

const pageMarkdown = (markdown: string, truncated: boolean) => ({
  object: "page_markdown",
  id: "p1",
  markdown,
  truncated,
  unknown_block_ids: [],
});

const fullComment = {
  object: "comment",
  id: "c1",
  parent: { type: "page_id", page_id: "p1" },
  discussion_id: "d1",
  created_time: "2026-09-01T00:00:00.000Z",
  last_edited_time: "2026-09-01T00:00:00.000Z",
  created_by: { object: "user", id: "u1" },
  rich_text: [
    { type: "text", plain_text: "lgtm, " },
    {
      type: "mention",
      plain_text: "@artfct",
      mention: { type: "user", user: { object: "user", id: "bot1" } },
    },
    { type: "text", plain_text: " ship it" },
  ],
  display_name: { type: "user", resolved_name: "Ann" },
};

const listed = (created: string, id: string) => ({
  ...fullComment,
  id,
  created_time: created,
  rich_text: [{ plain_text: `said at ${created}` }],
});

const emptyList = { object: "list", next_cursor: null, has_more: false, results: [] };
const listOf = (results: unknown[], nextCursor: string | null = null) => ({
  ...emptyList,
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
  results,
});
const block = (id: string, type: string, hasChildren: boolean) => ({
  object: "block",
  id,
  type,
  has_children: hasChildren,
  [type]: { rich_text: [] },
});
const pageComment = (id: string, discussion: string, author: string, text: string) => ({
  ...fullComment,
  id,
  discussion_id: discussion,
  created_by: { object: "user", id: author },
  rich_text: [{ type: "text", plain_text: text }],
});
const paths = (calls: Call[]) =>
  calls.map((call) => new URL(call.url).pathname + new URL(call.url).search);

describe("NotionDocuments", () => {
  describe("fetchComment", () => {
    describe("a comment with rich text and an author", () => {
      let calls: Call[];
      let comment: FetchedComment | null;

      beforeEach(async () => {
        const notion = notionDocuments(() => Response.json(fullComment));
        calls = notion.calls;
        comment = await notion.documents.fetchComment("c1");
      });

      it("joins the rich text and reads the author and the users it mentions", () => {
        expect(comment).toEqual({
          text: "lgtm, @artfct ship it",
          author: { id: "u1", email: null },
          mentions: ["bot1"],
        });
      });

      it("gets the comment by its id", () => {
        expect(calls[0]?.url).toBe("https://api.notion.com/v1/comments/c1");
        expect(calls[0]?.method).toBe("GET");
      });

      it("sends the integration token", () => {
        expect(calls[0]?.authorization).toBe("Bearer secret_x");
      });

      it("sends the Notion version the SDK pins", () => {
        expect(calls[0]?.version).toBe(Client.defaultNotionVersion);
      });

      it("sends no content type", () => {
        expect(calls[0]?.contentType).toBeNull();
      });
    });

    describe("a partial comment", () => {
      it("maps to empty text and no author", async () => {
        const { documents } = notionDocuments(() => Response.json({ object: "comment", id: "c1" }));
        expect(await documents.fetchComment("c1")).toEqual({
          text: "",
          author: null,
          mentions: [],
        });
      });
    });

    describe("a comment Notion no longer returns", () => {
      it("is null", async () => {
        const { documents } = notionDocuments(() =>
          Response.json(
            { object: "error", status: 404, code: "object_not_found", message: "gone" },
            { status: 404 },
          ),
        );
        expect(await documents.fetchComment("c1")).toBeNull();
      });
    });

    describe("a failure that is not a missing comment", () => {
      it("throws with the status", async () => {
        const { documents } = notionDocuments(() => new Response("nope", { status: 500 }));
        await expect(documents.fetchComment("c1")).rejects.toThrow("500");
      });
    });
  });

  const fullPage = {
    object: "page",
    id: "p1",
    created_time: "2026-09-01T00:00:00.000Z",
    last_edited_time: "2026-09-01T00:00:00.000Z",
    created_by: { object: "user", id: "u1" },
    last_edited_by: { object: "user", id: "u1" },
    parent: { type: "workspace", workspace: true },
    archived: false,
    properties: {},
    url: "https://notion.so/p1",
  };

  describe("document", () => {
    it("gets the page by its id and maps it", async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      expect(await notion.documents.page("p1")).toEqual({
        id: "p1",
        contentId: null,
        url: "https://notion.so/p1",
        revision: "2026-09-01T00:00:00.000Z",
      });
      expect(notion.calls[0]?.url).toBe("https://api.notion.com/v1/pages/p1");
    });

    it("is null for a page the integration cannot read", async () => {
      const { documents } = notionDocuments(() => Response.json({ object: "page", id: "p1" }));
      expect(await documents.page("p1")).toBeNull();
    });
  });

  describe("page", () => {
    it("gets the page by the id pageFromUrl returns and maps it", async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      expect(await notion.documents.page("p1")).toEqual({
        id: "p1",
        contentId: null,
        url: "https://notion.so/p1",
        revision: "2026-09-01T00:00:00.000Z",
      });
      expect(notion.calls[0]?.url).toBe("https://api.notion.com/v1/pages/p1");
    });

    it("is null for a page the integration cannot read", async () => {
      const { documents } = notionDocuments(() => Response.json({ object: "page", id: "p1" }));
      expect(await documents.page("p1")).toBeNull();
    });
  });

  describe("pageRemoved", () => {
    const url = "https://www.notion.so/Design-0123456789abcdef0123456789abcdef";

    it("gets the page the URL names", async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      await notion.documents.pageRemoved(url);
      expect(notion.calls[0]?.url).toBe(
        "https://api.notion.com/v1/pages/0123456789abcdef0123456789abcdef",
      );
    });

    it("is false for a page Notion still holds", async () => {
      const { documents } = notionDocuments(() => Response.json({ ...fullPage, in_trash: false }));
      expect(await documents.pageRemoved(url)).toBe(false);
    });

    it("is true for a page in the trash", async () => {
      const { documents } = notionDocuments(() => Response.json({ ...fullPage, in_trash: true }));
      expect(await documents.pageRemoved(url)).toBe(true);
    });

    it("is true for a page Notion no longer finds", async () => {
      const { documents } = notionDocuments(() =>
        Response.json(
          { object: "error", status: 404, code: "object_not_found", message: "gone" },
          { status: 404 },
        ),
      );
      expect(await documents.pageRemoved(url)).toBe(true);
    });

    it("is false for a URL of another host", async () => {
      const { documents } = notionDocuments(() => Response.json(fullPage));
      expect(await documents.pageRemoved("https://example.com/x")).toBe(false);
    });
  });

  describe("comments", () => {
    const page = {
      object: "list",
      type: "comment",
      comment: {},
      next_cursor: null,
      has_more: false,
      results: [
        listed("2026-09-03T00:00:00.000Z", "c3"),
        listed("2026-09-01T00:00:00.000Z", "c1"),
        listed("2026-09-02T00:00:00.000Z", "c2"),
      ],
    };

    it("lists the page's comments under its block id", async () => {
      const notion = notionDocuments(() => Response.json(page));
      await notion.documents.comments("p1", "2026-09-01T00:00:00.000Z");
      expect(notion.calls[0]?.url).toBe("https://api.notion.com/v1/comments?block_id=p1");
      expect(notion.calls[0]?.method).toBe("GET");
    });

    it("keeps the comments at or after since, oldest first", async () => {
      const { documents } = notionDocuments(() => Response.json(page));
      const comments = await documents.comments("p1", "2026-09-02T00:00:00.000Z");
      expect(comments.map((comment) => comment.id)).toEqual(["c2", "c3"]);
    });

    it("maps the id, time, text, and author", async () => {
      const { documents } = notionDocuments(() => Response.json(page));
      const comments = await documents.comments("p1", "2026-09-03T00:00:00.000Z");
      expect(comments).toEqual([
        {
          id: "c3",
          created_at: "2026-09-03T00:00:00.000Z",
          text: "said at 2026-09-03T00:00:00.000Z",
          author: { id: "u1", email: null },
        },
      ]);
    });
  });

  describe("heldComments", () => {
    const answers: Record<string, unknown> = {
      "/v1/users/me": { object: "user", id: "bot1", type: "bot", name: "artfct", bot: {} },
      "/v1/blocks/p1/children": listOf(
        [
          block("b1", "paragraph", false),
          block("b2", "toggle", true),
          block("b3", "child_page", true),
        ],
        "next1",
      ),
      "/v1/blocks/p1/children?start_cursor=next1": listOf([block("b4", "paragraph", false)]),
      "/v1/blocks/b2/children": listOf([block("b5", "paragraph", false)]),
      "/v1/comments?block_id=p1": listOf([pageComment("c1", "d1", "u1", "On the page.")]),
      "/v1/comments?block_id=b4": listOf([pageComment("c2", "d2", "u1", "Inline.")]),
      "/v1/comments?block_id=b5": listOf([
        pageComment("c3", "d3", "u2", "Nested."),
        pageComment("c4", "d3", "bot1", "👀"),
      ]),
    };
    const respond = (url: string) => {
      const { pathname, search } = new URL(url);
      return Response.json(answers[`${pathname}${search}`] ?? emptyList);
    };

    it("holds the page's comments and the inline ones a bot reply does not follow", async () => {
      const { documents } = notionDocuments(respond);
      expect(await documents.heldComments("p1")).toEqual([
        { id: "c1", author_name: "Ann", text: "On the page." },
        { id: "c2", author_name: "Ann", text: "Inline." },
      ]);
    });

    it("walks every page of children and the blocks nested under a block", async () => {
      const notion = notionDocuments(respond);
      await notion.documents.heldComments("p1");
      expect(paths(notion.calls).filter((path) => path.startsWith("/v1/blocks"))).toEqual([
        "/v1/blocks/p1/children",
        "/v1/blocks/p1/children?start_cursor=next1",
        "/v1/blocks/b2/children",
      ]);
    });

    it("lists comments under the page and each of its blocks, not under a child page", async () => {
      const notion = notionDocuments(respond);
      await notion.documents.heldComments("p1");
      expect(
        paths(notion.calls)
          .filter((path) => path.startsWith("/v1/comments"))
          .toSorted(),
      ).toEqual([
        "/v1/comments?block_id=b1",
        "/v1/comments?block_id=b2",
        "/v1/comments?block_id=b4",
        "/v1/comments?block_id=b5",
        "/v1/comments?block_id=p1",
      ]);
      expect(notion.calls.every((call) => call.method === "GET")).toBe(true);
    });

    it("keeps at most eight list requests in flight", async () => {
      let inFlight = 0;
      let mostInFlight = 0;
      const blocks = Array.from({ length: 30 }, (_, index) =>
        block(`b${index}`, "paragraph", false),
      );
      const fetch = async (input: string | URL | Request) => {
        const { pathname } = new URL(fetchUrl(input));
        if (pathname === "/v1/users/me") return Response.json(answers["/v1/users/me"]);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        if (pathname === "/v1/blocks/p1/children") return Response.json(listOf(blocks));
        return Response.json(emptyList);
      };
      await new NotionDocuments("secret_x", { fetch }).heldComments("p1");
      expect(mostInFlight).toBe(8);
      expect(mostInFlight).toBeGreaterThan(1);
    });
  });

  describe("self", () => {
    it("reads the bot user of the token and the name a mention shows", async () => {
      const notion = notionDocuments(() =>
        Response.json({ object: "user", id: "bot1", type: "bot", name: "artfct", bot: {} }),
      );
      expect(await notion.documents.self()).toEqual({ id: "bot1", name: "artfct" });
      expect(notion.calls[0]?.url).toBe("https://api.notion.com/v1/users/me");
      expect(notion.calls[0]?.method).toBe("GET");
    });
  });

  describe("comment", () => {
    describe("a comment on a page", () => {
      let calls: Call[];

      beforeEach(async () => {
        const notion = notionDocuments(() => Response.json(fullComment));
        calls = notion.calls;
        await notion.documents.comment("p1", "ship it");
      });

      it("posts to the comments collection", () => {
        expect(calls[0]?.url).toBe("https://api.notion.com/v1/comments");
        expect(calls[0]?.method).toBe("POST");
      });

      it("sends a JSON content type", () => {
        expect(calls[0]?.contentType).toBe("application/json");
      });

      it("sends the Notion version the SDK pins", () => {
        expect(calls[0]?.version).toBe(Client.defaultNotionVersion);
      });

      it("carries the text as a rich text block under the page", () => {
        expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
          parent: { page_id: "p1" },
          rich_text: [{ type: "text", text: { content: "ship it" } }],
        });
      });
    });

    describe("a page the integration cannot reach", () => {
      const denied = {
        object: "error",
        status: 403,
        code: "restricted_resource",
        message: "denied",
      };

      it("throws with the Notion message", async () => {
        const { documents } = notionDocuments(() => Response.json(denied, { status: 403 }));
        await expect(documents.comment("p1", "x")).rejects.toThrow("denied");
      });
    });
  });

  describe("acknowledgeComment", () => {
    describe("a comment the integration can read", () => {
      let calls: Call[];

      beforeEach(async () => {
        const notion = notionDocuments(() => Response.json(fullComment));
        calls = notion.calls;
        await notion.documents.acknowledgeComment({ pageId: "p1", commentId: "c1" });
      });

      it("reads the comment to learn its discussion", () => {
        expect(calls[0]?.url).toBe("https://api.notion.com/v1/comments/c1");
        expect(calls[0]?.method).toBe("GET");
      });

      it("posts to the comments collection", () => {
        expect(calls[1]?.url).toBe("https://api.notion.com/v1/comments");
        expect(calls[1]?.method).toBe("POST");
      });

      it("replies in the discussion with the eyes emoji alone", () => {
        expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
          discussion_id: "d1",
          rich_text: [{ type: "text", text: { content: "👀" } }],
        });
      });
    });

    describe("a comment the integration cannot read", () => {
      it("throws and posts nothing", async () => {
        const notion = notionDocuments(() => Response.json({ object: "comment", id: "c1" }));
        const comment = { pageId: "p1", commentId: "c1" };
        await expect(notion.documents.acknowledgeComment(comment)).rejects.toThrow("unreadable");
        expect(notion.calls).toHaveLength(1);
      });
    });
  });

  describe("userEmail", () => {
    describe("a person user", () => {
      const person = { object: "user", id: "u1", type: "person", person: { email: "ann@x.y" } };
      let calls: Call[];
      let email: string | null;

      beforeEach(async () => {
        const notion = notionDocuments(() => Response.json(person));
        calls = notion.calls;
        email = await notion.documents.userEmail("u1");
      });

      it("reads the person email", () => {
        expect(email).toBe("ann@x.y");
      });

      it("gets the user by its id", () => {
        expect(calls[0]?.url).toBe("https://api.notion.com/v1/users/u1");
        expect(calls[0]?.method).toBe("GET");
      });
    });

    describe("a bot user", () => {
      it("has no email", async () => {
        const bot = notionDocuments(() =>
          Response.json({ object: "user", id: "b1", type: "bot", bot: {} }),
        );
        expect(await bot.documents.userEmail("b1")).toBeNull();
      });
    });

    describe("a person who hides the email", () => {
      it("has no email", async () => {
        const hidden = notionDocuments(() =>
          Response.json({ object: "user", id: "u1", type: "person", person: {} }),
        );
        expect(await hidden.documents.userEmail("u1")).toBeNull();
      });
    });
  });

  describe("createPage", () => {
    const parentId = "3eb92fd781108088b848ebb16c8f4838";
    let calls: Call[];
    let page: DocumentPage;

    beforeEach(async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      calls = notion.calls;
      page = await notion.documents.createPage("Design", "# Design\n\nFirst draft.", parentId);
    });

    it("posts to the pages collection", () => {
      expect(calls[0]?.url).toBe("https://api.notion.com/v1/pages");
      expect(calls[0]?.method).toBe("POST");
    });

    it("sends the title and the markdown text under the parent page", () => {
      expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
        parent: { page_id: parentId },
        properties: { title: { title: [{ text: { content: "Design" } }] } },
        markdown: "# Design\n\nFirst draft.",
      });
    });

    it("maps the created page", () => {
      expect(page).toEqual({
        id: "p1",
        contentId: null,
        url: "https://notion.so/p1",
        revision: "2026-09-01T00:00:00.000Z",
      });
    });

    it("sends the page id of a parent given as a page url", async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      await notion.documents.createPage(
        "Design",
        "text",
        "https://app.notion.com/p/Welcome-3eb92fd7-8110-8088-b848-ebb16c8f4838",
      );
      expect(JSON.parse(notion.calls[0]?.body ?? "").parent).toEqual({ page_id: parentId });
    });

    it("refuses a parent that names no page, without a request", async () => {
      const notion = notionDocuments(() => Response.json(fullPage));
      await expect(notion.documents.createPage("Design", "text", "Engineering")).rejects.toThrow(
        'notion: "Engineering" does not name a page',
      );
      expect(notion.calls).toEqual([]);
    });
  });

  describe("readPageContent", () => {
    it("gets the page as markdown and returns the text", async () => {
      const notion = notionDocuments(() =>
        Response.json(pageMarkdown("# Design\n\nFirst draft.", false)),
      );
      expect(await notion.documents.readPageContent("p1")).toBe("# Design\n\nFirst draft.");
      expect(notion.calls[0]?.url).toBe("https://api.notion.com/v1/pages/p1/markdown");
      expect(notion.calls[0]?.method).toBe("GET");
    });

    it("throws for a page too long to read whole", async () => {
      const { documents } = notionDocuments(() => Response.json(pageMarkdown("# Design", true)));
      await expect(documents.readPageContent("p1")).rejects.toThrow("too long");
    });
  });

  describe("updatePageContent", () => {
    let calls: Call[];

    beforeEach(async () => {
      const notion = notionDocuments(() => Response.json(pageMarkdown("# Revised", false)));
      calls = notion.calls;
      await notion.documents.updatePageContent("p1", "# Revised");
    });

    it("patches the page markdown", () => {
      expect(calls[0]?.url).toBe("https://api.notion.com/v1/pages/p1/markdown");
      expect(calls[0]?.method).toBe("PATCH");
    });

    it("replaces the whole body with the text", () => {
      expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
        type: "replace_content",
        replace_content: { new_str: "# Revised" },
      });
    });
  });

  describe("two requests in a row", () => {
    let calls: Call[];

    beforeEach(async () => {
      const notion = notionDocuments(() => Response.json(fullComment));
      calls = notion.calls;
      await notion.documents.comment("p1", "x");
      await notion.documents.fetchComment("c1");
    });

    it("reaches the API once for each", () => {
      expect(calls).toHaveLength(2);
    });

    it("sends the token on every request", () => {
      expect(calls.every((call) => call.authorization === "Bearer secret_x")).toBe(true);
    });
  });

  describe("a custom base URL", () => {
    it("replaces the Notion host", async () => {
      const { documents, calls } = notionDocuments(
        () => Response.json(fullComment),
        "https://notion.test",
      );
      await documents.fetchComment("c1");
      expect(calls[0]?.url).toBe("https://notion.test/v1/comments/c1");
    });
  });
});
