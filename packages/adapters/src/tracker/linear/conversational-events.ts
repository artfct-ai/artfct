/**
 * The Linear vendor events the conversational path delivers to a conversation as starts or
 * messages. They never fire a trigger.
 */
export const linearConversationalEvents = [
  "linear.AgentSessionEvent.created",
  "linear.AgentSessionEvent.prompted",
  "linear.Comment.create",
] as const;

/** True when the vendor event name is one of Linear's conversational events. */
export function isLinearConversationalEvent(name: string): boolean {
  return (linearConversationalEvents as readonly string[]).includes(name);
}
