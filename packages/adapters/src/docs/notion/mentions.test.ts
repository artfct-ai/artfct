import type { RichTextItemResponse } from "@notionhq/client";
import { describe, expect, it } from "bun:test";
import { notionMentionedUserIds } from "./mentions";

const ANNOTATIONS = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default" as const,
};

function text(content: string): RichTextItemResponse {
  return {
    type: "text",
    text: { content, link: null },
    plain_text: content,
    href: null,
    annotations: ANNOTATIONS,
  };
}

function userMention(id: string, name: string): RichTextItemResponse {
  return {
    type: "mention",
    mention: { type: "user", user: { object: "user", id } },
    plain_text: `@${name}`,
    href: null,
    annotations: ANNOTATIONS,
  };
}

function dateMention(): RichTextItemResponse {
  return {
    type: "mention",
    mention: { type: "date", date: { start: "2026-09-30", end: null, time_zone: null } },
    plain_text: "2026-09-30",
    href: null,
    annotations: ANNOTATIONS,
  };
}

describe("notionMentionedUserIds", () => {
  it("reads the id of each user mention", () => {
    const richText = [userMention("bot-1", "artfct"), text(" go ahead "), userMention("u2", "Ann")];
    expect(notionMentionedUserIds(richText)).toEqual(["bot-1", "u2"]);
  });

  it("skips a mention of something other than a user", () => {
    expect(notionMentionedUserIds([dateMention(), text("by then")])).toEqual([]);
  });

  it("finds none in plain text that only looks like a mention", () => {
    expect(notionMentionedUserIds([text("@artfct go ahead")])).toEqual([]);
  });
});
