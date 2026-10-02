import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { fakeUserActor } from "../../../test/fake-actors";
import { FakeDocuments } from "../../../test/fake-documents";
import { notionInbound, type NotionWebhook } from "./inbound";
import type { DocsInbound, DocsInboundContext } from "../types";

const DASHED_PAGE = "1f2e3d4c-5b6a-7988-9a0b-1c2d3e4f5a6b";
const PAGE = "1f2e3d4c5b6a79889a0b1c2d3e4f5a6b";

const documents = new FakeDocuments({
  comments: {
    cmt1: {
      text: "lgtm",
      author: { id: "n1", email: "dev@acme.test" },
      mentions: [],
    },
  },
  emails: { n2: "ann@acme.test" },
});

const context: DocsInboundContext = { resolveActor: fakeUserActor(), documents };

function comment(data: NotionWebhook["data"]): NotionWebhook {
  return { id: "evt1", type: "comment.created", entity: { id: "cmt1", type: "comment" }, data };
}

function expectEvent(normalized: DocsInbound): InboundEvent {
  if ("ignore" in normalized) throw new Error(normalized.ignore);
  return normalized.event;
}

describe("notionInbound", () => {
  describe("a comment whose parent is a page", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await notionInbound(comment({ parent: { id: DASHED_PAGE, type: "page" } }), context),
      );
    });

    it("is feedback on the page", () => {
      expect(event.kind).toBe("feedback");
    });

    it("names the page and the comment, so the reply lands under it", () => {
      expect(event.page).toEqual({ page_id: PAGE, comment_id: "cmt1" });
    });

    it("reads the comment body back from the host", () => {
      expect(event.text).toBe("lgtm");
    });

    it("binds to the page id without dashes", () => {
      expect(event.bindings).toEqual([{ source: "docs_page", external_id: PAGE }]);
    });

    it("replies on the page the comment sits on", () => {
      expect(event.reply_to).toEqual({ source: "docs", page_id: DASHED_PAGE });
    });

    it("names the comment author as the actor", () => {
      expect(event.actor?.person_id).toBe("p_n1");
    });
  });

  describe("a comment under a block parent", () => {
    it("binds to the page id the payload carries", async () => {
      const event = expectEvent(
        await notionInbound(
          comment({ page_id: DASHED_PAGE, parent: { id: "blk-1", type: "block" } }),
          context,
        ),
      );
      expect(event.bindings).toEqual([{ source: "docs_page", external_id: PAGE }]);
    });
  });

  describe("a comment whose author carries no email", () => {
    it("asks the host for the profile email", async () => {
      const host = new FakeDocuments({
        comments: {
          cmt1: {
            text: "tighten the intro",
            author: { id: "n2", email: null },
            mentions: [],
          },
        },
        emails: { n2: "ann@acme.test" },
      });
      const event = expectEvent(
        await notionInbound(comment({ page_id: DASHED_PAGE }), {
          resolveActor: fakeUserActor(),
          documents: host,
        }),
      );
      expect(event.actor?.email).toBe("ann@acme.test");
    });
  });

  describe("a comment whose author is unknown", () => {
    it("is ignored", async () => {
      const host = new FakeDocuments({
        comments: {
          cmt1: { text: "please expand", author: null, mentions: [] },
        },
      });
      expect(
        await notionInbound(comment({ page_id: DASHED_PAGE }), {
          resolveActor: fakeUserActor(),
          documents: host,
        }),
      ).toEqual({ ignore: "comment author is not authorized" });
    });
  });

  describe("a comment whose author is not authorized", () => {
    it("is ignored", async () => {
      expect(
        await notionInbound(comment({ page_id: DASHED_PAGE }), {
          resolveActor: fakeUserActor({ authorized: false }),
          documents,
        }),
      ).toEqual({ ignore: "comment author is not authorized" });
    });
  });

  describe("a comment Notion no longer holds", () => {
    it("is ignored", async () => {
      const host = new FakeDocuments({ comments: { cmt1: null } });
      expect(
        await notionInbound(comment({ page_id: DASHED_PAGE }), {
          resolveActor: fakeUserActor(),
          documents: host,
        }),
      ).toEqual({ ignore: "comment Notion no longer holds" });
    });
  });

  describe("an event that is not a comment", () => {
    it("is ignored by its type", async () => {
      expect(await notionInbound({ id: "evt3", type: "page.updated" }, context)).toEqual({
        ignore: "page.updated",
      });
    });
  });

  describe("a comment with no page to bind to", () => {
    it("ignores a comment that carries no data", async () => {
      expect("ignore" in (await notionInbound(comment(undefined), context))).toBe(true);
    });

    it("ignores a comment whose only parent is a block", async () => {
      const blockOnly = await notionInbound(
        comment({ parent: { id: "blk-1", type: "block" } }),
        context,
      );
      expect("ignore" in blockOnly).toBe(true);
    });

    it("ignores a comment the webhook names no id for", async () => {
      const unnamed = { ...comment({ page_id: DASHED_PAGE }), entity: undefined };
      expect(await notionInbound(unnamed, context)).toEqual({ ignore: "comment without id" });
    });

    it("ignores a page id that is not a Notion id", async () => {
      expect("ignore" in (await notionInbound(comment({ page_id: "p1" }), context))).toBe(true);
    });
  });
});
