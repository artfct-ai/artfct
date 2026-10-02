import type { ModelMessage } from "ai";
import { asc, lte } from "drizzle-orm";
import type { WorkflowDb } from "../../workflow/store/db";
import type { Wake } from "../../workflow/types";
import { agentInbox, transcript } from "../../workflow/store/schema";
import { now } from "../../workflow/store/state";

/** One persisted model message with its row id. Compaction cuts on ids. */
export type TranscriptRow = { id: number; at: string; message: ModelMessage };

/**
 * The transcript and the inbox of the orchestrator agent. `agent_inbox` holds text that arrived since the last turn.
 * `transcript` is the conversation the model sees.
 */
export class TranscriptStore {
  constructor(private db: WorkflowDb) {}

  enqueue(text: string, wake: Wake): void {
    this.db.insert(agentInbox).values({ at: now(), text, wake }).run();
  }

  inbox(): Array<{ id: number; at: string; text: string; wake: Wake }> {
    return this.db.select().from(agentInbox).orderBy(asc(agentInbox.id)).all();
  }

  /** Move inbox rows into the transcript as one user message. Returns how many rows moved. */
  drainInbox(): number {
    const rows = this.inbox();
    if (rows.length === 0) return 0;
    this.append([{ role: "user", content: rows.map((row) => row.text).join("\n\n") }]);
    this.db.delete(agentInbox).run();
    return rows.length;
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
