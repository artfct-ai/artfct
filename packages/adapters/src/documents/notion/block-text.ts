import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";

/** The plain text a reader sees in one block. Empty for a block that holds no text. */
export function notionBlockText(block: BlockObjectResponse): string {
  switch (block.type) {
    case "paragraph":
      return plainText(block.paragraph.rich_text);
    case "heading_1":
      return plainText(block.heading_1.rich_text);
    case "heading_2":
      return plainText(block.heading_2.rich_text);
    case "heading_3":
      return plainText(block.heading_3.rich_text);
    case "heading_4":
      return plainText(block.heading_4.rich_text);
    case "bulleted_list_item":
      return plainText(block.bulleted_list_item.rich_text);
    case "numbered_list_item":
      return plainText(block.numbered_list_item.rich_text);
    case "quote":
      return plainText(block.quote.rich_text);
    case "to_do":
      return plainText(block.to_do.rich_text);
    case "toggle":
      return plainText(block.toggle.rich_text);
    case "callout":
      return plainText(block.callout.rich_text);
    case "code":
      return plainText(block.code.rich_text);
    case "table_row":
      return block.table_row.cells.map(plainText).join(" ");
    default:
      return "";
  }
}

function plainText(parts: RichTextItemResponse[]): string {
  return parts.map((part) => part.plain_text).join("");
}
