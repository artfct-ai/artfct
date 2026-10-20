import { describe, expect, it } from "bun:test";
import {
  NOTION_TEST_BOT as BOT,
  notionTestComment as comment,
  notionTestHeldIds as heldIds,
} from "../../../test/notion-comments";
import { notionHeldComments } from "./held-comments";

describe("notionHeldComments", () => {
  it("holds a person's comment without an acknowledgement", () => {
    const held = notionHeldComments(
      [comment({ id: "c1", commentThread: "d1", author: "ann", text: "Tighten the intro." })],
      BOT,
    );
    expect(held).toEqual([{ id: "c1", author_name: "Ann", text: "Tighten the intro." }]);
  });

  it("never holds the bot's own comments", () => {
    expect(
      heldIds([comment({ id: "c1", commentThread: "d1", author: BOT, text: "Review: fine." })]),
    ).toEqual([]);
  });

  it("marks only the earliest held comment before an acknowledgement in its comment thread", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d1", author: "bob", text: "Two." }),
        comment({ id: "c3", commentThread: "d1", author: BOT, text: "👀" }),
      ]),
    ).toEqual(["c2"]);
  });

  it("marks each comment of a comment thread that an acknowledgement each follows", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d1", author: "bob", text: "Two." }),
        comment({ id: "c3", commentThread: "d1", author: BOT, text: "👀" }),
        comment({ id: "c4", commentThread: "d1", author: BOT, text: "👀" }),
      ]),
    ).toEqual([]);
  });

  it("holds a reply written after the acknowledgement", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d1", author: BOT, text: "👀" }),
        comment({ id: "c3", commentThread: "d1", author: "ann", text: "And another." }),
      ]),
    ).toEqual(["c3"]);
  });

  it("holds a comment when the acknowledgement is in another comment thread", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d2", author: "bob", text: "Two." }),
        comment({ id: "c3", commentThread: "d2", author: BOT, text: "👀" }),
      ]),
    ).toEqual(["c1"]);
  });

  it("holds a comment a person answered with the same emoji", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d1", author: "bob", text: "👀" }),
      ]),
    ).toEqual(["c1", "c2"]);
  });

  it("holds a comment the bot answered with other text", () => {
    expect(
      heldIds([
        comment({ id: "c1", commentThread: "d1", author: "ann", text: "One." }),
        comment({ id: "c2", commentThread: "d1", author: BOT, text: "Revised." }),
      ]),
    ).toEqual(["c1"]);
  });
});
