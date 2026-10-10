import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { ModelMessage } from "ai";
import { asc, eq, lte } from "drizzle-orm";
import type { WorkflowDb } from "../../workflow/store/db";
import type { Wake } from "../../workflow/types";
import { agentInbox, transcript } from "../../workflow/store/schema";
import { now, type ChatMessageRef } from "../../workflow/store/state";

/**
 * One inbox row. `reply_to` is where the person who wrote it waits, or null. `chat_message` is
 * the chat message they wrote, or null. `taken` marks a row of the running turn.
 */
export type InboxRow = typeof agentInbox.$inferSelect;

/** Where a person wrote an inbox row from: where they wait for the answer, and their chat message. */
export type WroteFrom = { reply_to?: ReplyTarget; chat_message?: ChatMessageRef };

/** One persisted model message with its row id. Compaction cuts on ids. */
export type TranscriptRow = { id: number; at: string; message: ModelMessage };

/**
 * The transcript and the inbox of the orchestrator agent. `agent_inbox` holds what waits for the
 * next turn and what the running turn took. `transcript` is the conversation the model sees.
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

  /** The rows that wait for the next turn. */
  inbox(): InboxRow[] {
    return this.db
      .select()
      .from(agentInbox)
      .where(eq(agentInbox.taken, false))
      .orderBy(asc(agentInbox.id))
      .all();
  }

  /** The rows the running turn took, or a lost turn left for its resume. */
  taken(): InboxRow[] {
    return this.db
      .select()
      .from(agentInbox)
      .where(eq(agentInbox.taken, true))
      .orderBy(asc(agentInbox.id))
      .all();
  }

  /**
   * Take the waiting rows for the running turn and add their text to the transcript as one user
   * message. Returns its row id, or null when no row waited.
   */
  takeInbox(): number | null {
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
    this.db
      .update(agentInbox)
      .set({ taken: true })
      .where(lte(agentInbox.id, rows.at(-1)!.id))
      .run();
    return id;
  }

  /** Where the people the running turn answers wrote from. */
  answering(): ReplyTarget[] {
    return this.takenMessages().flatMap((row) => (row.reply_to ? [row.reply_to] : []));
  }

  /** The messages people wrote that the running turn owes a reply. */
  takenMessages(): InboxRow[] {
    return this.taken().filter((row) => row.wake === "message");
  }

  /** The running turn's rows whose chat message does not have the thumbs-up yet. */
  awaitingThumbsUp(): InboxRow[] {
    return this.takenMessages().filter((row) => row.chat_message && !row.reacted);
  }

  /** Record that the thumbs-up landed on the row's chat message. */
  markReacted(id: number): void {
    this.db.update(agentInbox).set({ reacted: true }).where(eq(agentInbox.id, id)).run();
  }

  /** Delete the rows of a turn that ended. */
  deleteTaken(): void {
    this.db.delete(agentInbox).where(eq(agentInbox.taken, true)).run();
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
