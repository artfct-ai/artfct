import type { RichTextItemResponse } from "@notionhq/client";

/** The ids of the users a Notion comment mentions, in the order its rich text names them. */
export function notionMentionedUserIds(richText: RichTextItemResponse[]): string[] {
  return richText.flatMap((part) =>
    part.type === "mention" && part.mention.type === "user" ? [part.mention.user.id] : [],
  );
}
