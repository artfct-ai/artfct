import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ModelMessage } from "ai";
import { asc, lte } from "drizzle-orm";
import type { WorkflowDb } from "../../workflow/store/db";
import type { Wake } from "../../workflow/types";
import { agentInbox, transcript } from "../../workflow/store/schema";
import { now, type ChatMessageRef } from "../../workflow/store/state";

/**
 * One inbox row. `reply_to` is where the person who wrote it waits, or null. `chat_message` is
 * the chat message they wrote, or null.
 */
export type InboxRow = typeof agentInbox.$inferSelect;

/** Where a person wrote an inbox row from: where they wait for the answer, and their chat message. */
export type WroteFrom = { reply_to?: ReplyTarget; chat_message?: ChatMessageRef };

/** One persisted model message with its row id. Compaction cuts on ids. */
export type TranscriptRow = { id: number; at: string; message: ModelMessage };

/**
 * The transcript and the inbox of the orchestrator agent. `agent_inbox` holds text that arrived since the last turn.
 * `transcript` is the conversation the model sees.
 */
export class TranscriptStore {
  constructor(private db: WorkflowDb) {}

  /** Queue text for the next turn. `from` says where the person who wrote it wrote from. */
  enqueue(text: string, wake: Wake, from: WroteFrom = {}): void {
    this.db
      .insert(agentInbox)
      .values({
        at: now(),
        text,
        wake,
        reply_to: from.reply_to ?? null,
        chat_message: from.chat_message ?? null,
      })
      .run();
  }

  inbox(): InboxRow[] {
    return this.db.select().from(agentInbox).orderBy(asc(agentInbox.id)).all();
  }

  /**
   * Move inbox rows into the transcript as one user message. Returns its row id, or null when the
   * inbox was empty.
   */
  drainInbox(): number | null {
    const rows = this.inbox();
    if (rows.length === 0) return null;
    const message: ModelMessage = {
      role: "user",
      content: rows.map((row) => row.text).join("\n\n"),
    };
    const { id } = this.db
      .insert(transcript)
      .values({ at: now(), message })
      .returning({ id: transcript.id })
      .get();
    this.db.delete(agentInbox).run();
    return id;
  }

  append(messages: ModelMessage[]): void {
    for (const message of messages) {
      this.db.insert(transcript).values({ at: now(), message }).run();
    }
  }

  all(): TranscriptRow[] {
    return this.db
      .select()
      .from(transcript)
      .orderBy(asc(transcript.id))
      .all()
      .map((row) => ({ id: row.id, at: row.at, message: row.message as ModelMessage }));
  }

  /** Replace every row up to and including `lastId` with one message that takes that id. */
  replaceThrough(lastId: number, message: ModelMessage): void {
    this.db.delete(transcript).where(lte(transcript.id, lastId)).run();
    this.db.insert(transcript).values({ id: lastId, at: now(), message }).run();
  }
}
