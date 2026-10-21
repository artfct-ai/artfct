/**
 * The Notion vendor events the conversational path delivers to a conversation as messages. They
 * never fire a trigger.
 */
export const notionConversationalEvents = ["notion.comment.created"] as const;

/** True when the vendor event name is one of Notion's conversational events. */
export function isNotionConversationalEvent(name: string): boolean {
  return (notionConversationalEvents as readonly string[]).includes(name);
}
