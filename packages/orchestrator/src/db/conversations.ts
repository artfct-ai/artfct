import type { ConversationPlace } from "@artfct-ai/contracts/sources";
import { and, eq } from "drizzle-orm";
import { nowIso, type Database } from "./client";
import { conversations } from "./schema";

/** The key a place's conversation row is stored under. */
function conversationPlaceKey(place: ConversationPlace): {
  source: ConversationPlace["source"];
  external_id: string;
} {
  switch (place.source) {
    case "chat_thread":
      return { source: place.source, external_id: `${place.channel}:${place.thread}` };
    case "tracker_issue":
      return { source: place.source, external_id: place.issue_id };
    case "tracker_session":
      return { source: place.source, external_id: place.session_id };
    default: {
      const unreachable: never = place;
      throw new Error(`unhandled place ${String(unreachable)}`);
    }
  }
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Characters of the place digest in a conversation id. */
const CONVERSATION_DIGEST_LENGTH = 16;

/**
 * The id of a place's conversation, which names its Durable Object. Format `cv_<base32>`. Two
 * deliveries to one place derive the same id.
 */
export async function conversationIdOf(place: ConversationPlace): Promise<string> {
  const { source, external_id } = conversationPlaceKey(place);
  const text = new TextEncoder().encode(`${source}:${external_id}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", text));
  const characters = Array.from(digest.subarray(0, CONVERSATION_DIGEST_LENGTH), (byte) => {
    return BASE32_ALPHABET[byte % 32];
  });
  return `cv_${characters.join("")}`;
}

/** Record that a place has a conversation. A row that exists stays. */
export async function recordConversation(db: Database, place: ConversationPlace): Promise<void> {
  await db
    .insert(conversations)
    .values({ ...conversationPlaceKey(place), created_at: nowIso() })
    .onConflictDoNothing();
}

/** True when a start opened the place's conversation. */
export async function conversationRecorded(
  db: Database,
  place: ConversationPlace,
): Promise<boolean> {
  const { source, external_id } = conversationPlaceKey(place);
  const row = await db
    .select({ source: conversations.source })
    .from(conversations)
    .where(and(eq(conversations.source, source), eq(conversations.external_id, external_id)))
    .get();
  return row !== undefined;
}
