/**
 * The Slack vendor events the conversational path delivers to a conversation as starts or
 * messages. They never fire a trigger.
 */
export const slackConversationalEvents = [
  "slack.app_mention",
  "slack.message",
  "slack.reaction_added",
] as const;

/** True when the vendor event name is one of Slack's conversational events. */
export function isSlackConversationalEvent(name: string): boolean {
  return (slackConversationalEvents as readonly string[]).includes(name);
}
