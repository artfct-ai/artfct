import type { ArtifactStatus } from "@artfct-ai/contracts/types";
import { and, count, desc, eq, getTableColumns, inArray, ne, notInArray } from "drizzle-orm";
import type { WorkflowDb } from "./db";
import { artifactRefKey } from "./input-key";
import { artifacts, DELIVERY_ERROR, events, jobs, log, outbox, tasks } from "./schema";
import { FINISHED_TASK_STATUSES, now } from "./state";

/** Outbox channels a human reads. Board and internal rows reach nobody. */
const HUMAN_CHANNELS = ["chat", "tracker", "docs"] as const;
/** Rows on a human channel that carry no message: an issue state move, a call that failed. */
const SILENT_KINDS = ["issue_update", DELIVERY_ERROR] as const;

/** Joins an artifact to the author task of its job, whose status orders and filters artifacts. */
const authorTaskOfArtifact = and(eq(tasks.job_id, artifacts.job_id), eq(tasks.role, "author"));

export type ArtifactRow = typeof artifacts.$inferSelect;

function sameArtifactAs(row: ArtifactRow): (other: ArtifactRow) => boolean {
  const key = artifactRefKey({ ref: row.ref, url: row.external_url });
  return (other) => artifactRefKey({ ref: other.ref, url: other.external_url }) === key;
}
export type OutboxEntry = Pick<
  typeof outbox.$inferSelect,
  "channel" | "kind" | "target" | "payload"
>;

/** Queries over the record tables: artifacts, outbox, events, and log. */
export class RecordStore {
  constructor(protected db: WorkflowDb) {}

  artifact(jobId: string): ArtifactRow | null {
    return this.db.select().from(artifacts).where(eq(artifacts.job_id, jobId)).get() ?? null;
  }

  artifacts(): ArtifactRow[] {
    return this.db.select().from(artifacts).all();
  }

  /** The artifact that is this pull request, if any job produced it. */
  artifactByPull(repo: string, number: number): ArtifactRow | null {
    return this.artifactMatching(
      ({ ref }) => ref.kind === "pull" && ref.repo === repo && ref.number === number,
    );
  }

  /** The artifact that is this document page, if any job produced it. */
  artifactByPage(pageId: string): ArtifactRow | null {
    return this.artifactMatching(({ ref }) => ref.kind === "page" && ref.page_id === pageId);
  }

  /**
   * Artifacts the host has neither accepted nor removed, oldest job first. An artifact a later
   * job continues is listed once, under the job that holds it now.
   */
  openArtifacts(): ArtifactRow[] {
    return this.db
      .select({ ...getTableColumns(artifacts) })
      .from(artifacts)
      .innerJoin(tasks, authorTaskOfArtifact)
      .where(inArray(artifacts.status, ["drafted", "ready"]))
      .orderBy(tasks.started_at)
      .all()
      .filter((row) => this.artifactMatching(sameArtifactAs(row))?.job_id === row.job_id);
  }

  /** The row of the artifact that matches. The one whose author task still runs, else the newest. */
  private artifactMatching(matches: (artifact: ArtifactRow) => boolean): ArtifactRow | null {
    const rows = this.db
      .select({ artifact: artifacts, status: tasks.status })
      .from(artifacts)
      .innerJoin(tasks, authorTaskOfArtifact)
      .orderBy(desc(tasks.started_at))
      .all()
      .filter((row) => matches(row.artifact));
    const active = rows.find((row) => !FINISHED_TASK_STATUSES.includes(row.status));
    return (active ?? rows[0])?.artifact ?? null;
  }

  /** Insert or replace the artifact. It starts as a draft that no refiner has yet. */
  upsertArtifact(
    artifact: Omit<
      ArtifactRow,
      "updated_at" | "status" | "refiner_task_id" | "delivered_to_humans_at" | "delivered_revision"
    >,
  ): void {
    const row = { ...artifact, updated_at: now() };
    this.db
      .insert(artifacts)
      .values({ ...row, status: "drafted", refiner_task_id: null })
      .onConflictDoUpdate({ target: artifacts.job_id, set: row })
      .run();
  }

  /** Move the artifact on from one of `from` to `to`. False when it is somewhere else already. */
  advanceArtifact(jobId: string, from: ArtifactStatus[], to: ArtifactStatus): boolean {
    const artifact = this.artifact(jobId);
    if (!artifact || !from.includes(artifact.status)) return false;
    this.db
      .update(artifacts)
      .set({ status: to, updated_at: now() })
      .where(eq(artifacts.job_id, jobId))
      .run();
    return true;
  }

  /** Point the artifact at the refiner run working on it, or at none when it leaves the review. */
  setArtifactRefinerRun(jobId: string, refinerRunId: string | null): void {
    this.db
      .update(artifacts)
      .set({ refiner_task_id: refinerRunId, updated_at: now() })
      .where(eq(artifacts.job_id, jobId))
      .run();
  }

  /** Keep the revision the humans just got, and when they first got the artifact. */
  recordHandover(jobId: string, revision: string | null): void {
    const at = now();
    const firstAt = this.artifact(jobId)?.delivered_to_humans_at ?? at;
    this.db
      .update(artifacts)
      .set({ delivered_revision: revision, delivered_to_humans_at: firstAt, updated_at: at })
      .where(eq(artifacts.job_id, jobId))
      .run();
  }

  /** Artifacts of the other jobs whose author is done, with their stage names. */
  previousArtifacts(exceptJobId: string): Array<ArtifactRow & { stage: string }> {
    return this.db
      .select({ ...getTableColumns(artifacts), stage: jobs.stage })
      .from(artifacts)
      .innerJoin(jobs, eq(jobs.job_id, artifacts.job_id))
      .innerJoin(tasks, authorTaskOfArtifact)
      .where(and(ne(artifacts.job_id, exceptJobId), eq(tasks.status, "done")))
      .all();
  }

  writeOutbox(entry: OutboxEntry): void {
    if (entry.kind === DELIVERY_ERROR) console.error("delivery failed", entry);
    this.db
      .insert(outbox)
      .values({ ...entry, at: now() })
      .run();
  }

  outbox(): (typeof outbox.$inferSelect)[] {
    return this.db.select().from(outbox).orderBy(outbox.id).all();
  }

  /** How many outbox rows a person can read. Compare two readings to see whether anything posted. */
  postedCount(): number {
    return (
      this.db
        .select({ total: count() })
        .from(outbox)
        .where(
          and(
            inArray(outbox.channel, [...HUMAN_CHANNELS]),
            notInArray(outbox.kind, [...SILENT_KINDS]),
          ),
        )
        .get()?.total ?? 0
    );
  }

  /** Record the event id. False when it was seen before. */
  markEventSeen(event: { id: string; kind: string }): boolean {
    const seen = this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, event.id))
      .get();
    if (seen) return false;
    this.db
      .insert(events)
      .values({ ...event, at: now() })
      .run();
    return true;
  }

  appendLog(taskId: string | null, line: string): void {
    this.db.insert(log).values({ at: now(), task_id: taskId, line }).run();
  }

  logLines(): Array<Pick<typeof log.$inferSelect, "at" | "task_id" | "line">> {
    return this.db
      .select({ at: log.at, task_id: log.task_id, line: log.line })
      .from(log)
      .orderBy(log.id)
      .all();
  }
}
