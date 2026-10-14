import type { CreateCommentParameters } from "@notionhq/client";

/** The rich text of a comment as Notion takes it in a request. */
type NotionCommentRichText = Extract<CreateCommentParameters, { rich_text: unknown }>["rich_text"];

/** The most characters Notion takes in one rich text item. */
const NOTION_RICH_TEXT_CHARS = 2000;

/** Plain text as Notion rich text, split into items Notion takes, in order. */
export function notionRichText(text: string): NotionCommentRichText {
  const items: NotionCommentRichText = [];
  for (let start = 0; start < text.length; start += NOTION_RICH_TEXT_CHARS) {
    const content = text.slice(start, start + NOTION_RICH_TEXT_CHARS);
    items.push({ type: "text", text: { content } });
  }
  return items;
}
