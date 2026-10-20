import type { CreateCommentParameters } from "@notionhq/client";

/** The rich text of a comment as Notion takes it in a request. */
type NotionCommentRichText = Extract<CreateCommentParameters, { rich_text: unknown }>["rich_text"];

/** The most characters Notion takes in one rich text item. */
const NOTION_RICH_TEXT_CHARS = 2000;

/**
 * Plain text as Notion rich text, split into items Notion takes, in order. A cut never splits a
 * surrogate pair.
 */
export function notionRichText(text: string): NotionCommentRichText {
  const items: NotionCommentRichText = [];
  for (let start = 0; start < text.length;) {
    const end = richTextItemEnd(text, start + NOTION_RICH_TEXT_CHARS);
    items.push({ type: "text", text: { content: text.slice(start, end) } });
    start = end;
  }
  return items;
}

function richTextItemEnd(text: string, limit: number): number {
  if (limit >= text.length) return text.length;
  const lastUnit = text.charCodeAt(limit - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? limit - 1 : limit;
}
