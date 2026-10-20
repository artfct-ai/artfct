import type { CommentObjectResponse } from "@notionhq/client";
import { notionHeldComments } from "../src/documents/notion/held-comments";

/** The integration user that writes the bot's comments in a held comments test. */
export const NOTION_TEST_BOT = "bot1";

/** A Notion comment in a comment thread, written by the integration when its author is the test bot. */
export function notionTestComment(options: {
  id: string;
  commentThread: string;
  author: string;
  text: string;
}): CommentObjectResponse {
  return {
    object: "comment",
    id: options.id,
    parent: { type: "page_id", page_id: "p1" },
    discussion_id: options.commentThread,
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
      type: options.author === NOTION_TEST_BOT ? "integration" : "user",
      resolved_name: options.author === NOTION_TEST_BOT ? "artfct" : "Ann",
    },
  };
}

/** The ids of the comments the test bot holds. */
export function notionTestHeldIds(comments: CommentObjectResponse[]): string[] {
  return notionHeldComments(comments, NOTION_TEST_BOT).map((held) => held.id);
}
