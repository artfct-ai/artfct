/** The most characters Notion takes in one rich text item. */
const NOTION_RICH_TEXT_ITEM_CHARS = 2000;

/** One plain text item of Notion rich text. */
type NotionTextItem = { type: "text"; text: { content: string } };

/** Plain text as Notion rich text items, split into items Notion accepts. */
export function notionRichText(text: string): NotionTextItem[] {
  const items: NotionTextItem[] = [];
  for (let start = 0; start < text.length; start += NOTION_RICH_TEXT_ITEM_CHARS) {
    items.push({
      type: "text",
      text: { content: text.slice(start, start + NOTION_RICH_TEXT_ITEM_CHARS) },
    });
  }
  return items;
}
