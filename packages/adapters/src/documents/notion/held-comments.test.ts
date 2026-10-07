import type { CommentObjectResponse } from "@notionhq/client";
import { describe, expect, it } from "bun:test";
import { notionHeldComments } from "./held-comments";

const BOT = "bot1";

function comment(options: {
  id: string;
  discussion: string;
  author: string;
  text: string;
}): CommentObjectResponse {
  return {
    object: "comment",
    id: options.id,
    parent: { type: "page_id", page_id: "p1" },
    discussion_id: options.discussion,
    created_time: "2026-09-01T00:00:00.000Z",
    last_edited_time: "2026-09-01T00:00:00.000Z",
    created_by: { object: "user", id: options.author },
    rich_text: [
      {
        type: "text",
        text: { content: options.text, link: null },
        plain_text: options.text,
        href: null,
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: "default",
        },
      },
    ],
    display_name: {
      type: options.author === BOT ? "integration" : "user",
      resolved_name: options.author === BOT ? "artfct" : "Ann",
    },
  };
}

function heldIds(comments: CommentObjectResponse[]): string[] {
  return notionHeldComments(comments, BOT).map((held) => held.id);
}

describe("notionHeldComments", () => {
  it("holds a person's comment without an acknowledgement", () => {
    const held = notionHeldComments(
      [comment({ id: "c1", discussion: "d1", author: "ann", text: "Tighten the intro." })],
      BOT,
    );
    expect(held).toEqual([{ id: "c1", author_name: "Ann", text: "Tighten the intro." }]);
  });

  it("never holds the bot's own comments", () => {
    expect(
      heldIds([comment({ id: "c1", discussion: "d1", author: BOT, text: "Review: fine." })]),
    ).toEqual([]);
  });

  it("does not hold the comments an acknowledgement follows in the discussion", () => {
    expect(
      heldIds([
        comment({ id: "c1", discussion: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", discussion: "d1", author: "bob", text: "Two." }),
        comment({ id: "c3", discussion: "d1", author: BOT, text: "👀" }),
      ]),
    ).toEqual([]);
  });

  it("holds a reply written after the acknowledgement", () => {
    expect(
      heldIds([
        comment({ id: "c1", discussion: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", discussion: "d1", author: BOT, text: "👀" }),
        comment({ id: "c3", discussion: "d1", author: "ann", text: "And another." }),
      ]),
    ).toEqual(["c3"]);
  });

  it("holds a comment when the acknowledgement is in another discussion", () => {
    expect(
      heldIds([
        comment({ id: "c1", discussion: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", discussion: "d2", author: "bob", text: "Two." }),
        comment({ id: "c3", discussion: "d2", author: BOT, text: "👀" }),
      ]),
    ).toEqual(["c1"]);
  });

  it("holds a comment a person answered with the same emoji", () => {
    expect(
      heldIds([
        comment({ id: "c1", discussion: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", discussion: "d1", author: "bob", text: "👀" }),
      ]),
    ).toEqual(["c1", "c2"]);
  });

  it("holds a comment the bot answered with other text", () => {
    expect(
      heldIds([
        comment({ id: "c1", discussion: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", discussion: "d1", author: BOT, text: "Revised." }),
      ]),
    ).toEqual(["c1"]);
  });
});
