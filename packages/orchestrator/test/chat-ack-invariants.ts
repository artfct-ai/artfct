/** What a delivery settled with, as the router saw it or as its caller got it. */
export type ChatAckOutcome =
  | { kind: "returned"; value: string }
  | { kind: "threw"; message: string };

/** One reaction call on a chat message, and whether the chat accepted it. */
export type ObservedReaction = { method: "addReaction" | "removeReaction"; accepted: boolean };

/** One message delivered through the chat acknowledgement, and what its thread saw. */
export type ChatAckRecord = {
  /** True when the message came from a chat thread and names the message to react to. */
  fromChat: boolean;
  /** True when the workflow took the message after the eyes delay passed. */
  slow: boolean;
  /** Every reaction call on this message, in order. */
  reactions: ObservedReaction[];
  /** What the workflow delivery settled with. */
  delivered: ChatAckOutcome;
  /** What the caller of the chat acknowledgement got. */
  returned: ChatAckOutcome;
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * Eyes the chat accepted come off once the delivery settles. A message gets the eyes at most
 * once, and a removal follows only an accepted reaction.
 */
export function eyesNeverOutliveTheDelivery(record: ChatAckRecord): void {
  const adds = record.reactions.filter((reaction) => reaction.method === "addReaction");
  if (adds.length > 1) violated("eyesNeverOutliveTheDelivery", "the message got the eyes twice");
  const expected = adds.some((reaction) => reaction.accepted)
    ? ["addReaction", "removeReaction"]
    : adds.map((reaction) => reaction.method);
  const actual = record.reactions.map((reaction) => reaction.method);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violated("eyesNeverOutliveTheDelivery", `reaction calls were ${JSON.stringify(actual)}`);
  }
}

/** Only a chat message that waited past the delay for its workflow gets the eyes. */
export function eyesMarkOnlyASlowChatDelivery(record: ChatAckRecord): void {
  if (record.reactions.length === 0 || (record.fromChat && record.slow)) return;
  violated(
    "eyesMarkOnlyASlowChatDelivery",
    `a ${record.fromChat ? "chat" : "tracker"} message that was ${record.slow ? "slow" : "prompt"} got reaction calls`,
  );
}

/** The caller gets exactly what the delivery settled with, whatever the reaction calls did. */
export function theCallerGetsWhatTheDeliveryGave(record: ChatAckRecord): void {
  if (JSON.stringify(record.returned) === JSON.stringify(record.delivered)) return;
  violated(
    "theCallerGetsWhatTheDeliveryGave",
    `the delivery gave ${JSON.stringify(record.delivered)} and the caller got ${JSON.stringify(record.returned)}`,
  );
}

/** Every chat acknowledgement invariant. */
export const CHAT_ACK_INVARIANTS = [
  eyesNeverOutliveTheDelivery,
  eyesMarkOnlyASlowChatDelivery,
  theCallerGetsWhatTheDeliveryGave,
];
