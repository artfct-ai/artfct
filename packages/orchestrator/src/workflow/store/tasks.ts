import { and, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Review } from "../../artifact/types";
import type { TaskRole } from "../task/events";
import { TURN_PURPOSE } from "../../agent/model/usage";
import {
  jobs,
  modelUsage,
  promptQueue,
  reviews,
  rpc,
  rulings,
  sandboxes,
  sessionFeeds,
  tasks,
} from "./schema";
import type { RpcPurpose } from "./schema";
import { FINISHED_TASK_STATUSES, now } from "./state";
import { WorkflowRowStore } from "./workflow-row";

export type { ArtifactRow } from "./records";
export type JobRow = typeof jobs.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SandboxRow = typeof sandboxes.$inferSelect;
export type SessionFeedRow = typeof sessionFeeds.$inferSelect;
export type QueuedPrompt = Pick<typeof promptQueue.$inferSelect, "id" | "text">;
export type PendingRpc = Pick<typeof rpc.$inferSelect, "purpose" | "method">;
export type ModelUsageRow = typeof modelUsage.$inferSelect;
export type NewModelUsage = Omit<ModelUsageRow, "id" | "at">;

/** Where the ruling on a judge run stands: a person is asked for it, or the judge ruled on a revision. */
export type RulingState =
  | { status: "asked" }
  | { status: "approved"; revision: string | null }
  | { status: "rejected"; revision: string | null; reason: string };

/** A refiner run with the review or the ruling it filed. */
export type RefinerRun = TaskRow & { review: Review | null; ruling: RulingState | null };

function reviewOf(row: typeof reviews.$inferSelect): Review {
  return {
    revision: row.revision,
    blocking: row.blocking,
    summary: row.summary,
    findings: row.findings,
  };
}

function rulingStateOf(row: typeof rulings.$inferSelect): RulingState {
  switch (row.status) {
    case "asked":
      return { status: "asked" };
    case "approved":
      return { status: "approved", revision: row.revision };
    case "rejected":
      if (row.reason === null) throw new Error(`the rejection of ${row.task_id} has no reason`);
      return { status: "rejected", revision: row.revision, reason: row.reason };
    default: {
      const unhandled: never = row.status;
      throw new Error(`unknown ruling status ${String(unhandled)}`);
    }
  }
}

/**
 * Columns the caller sets when a job is created. Its researcher writes the research payload
 * later. The input artifact columns and the author overrides are set only on the jobs that have them.
 */
export type NewJob = Omit<
  JobRow,
  | "created_at"
  | "research_payload"
  | "selection"
  | "author_harness"
  | "author_model"
  | "input_ref"
  | "input_url"
> &
  Partial<Pick<JobRow, "author_harness" | "author_model" | "input_ref" | "input_url">>;

/** Columns the caller sets when a sandbox row is created. */
type NewSandbox = Pick<SandboxRow, "harness" | "bridge_token">;

/**
 * Columns the caller sets when a task is created. Everything else has a default. A refiner run
 * names the refiner it runs. A model-call task has no sandbox.
 */
export type NewTask = Pick<TaskRow, "task_id" | "job_id" | "model"> & {
  sandbox: NewSandbox | null;
} & ({ role: "author" | "researcher" } | { role: "reviewer" | "polisher"; refiner_index: number });

/** How much of a turn's text is kept: enough for the summary, artifact scan, and report. */
export const TURN_TEXT_CHARS = 12_000;

/** What joins two narration lines in one post. */
const NARRATION_LINE_SEPARATOR = "\n\n";

const JOB_ROLES: TaskRole[] = ["author", "researcher"];
const REFINER_ROLES: TaskRole[] = ["reviewer", "polisher"];

const HANDSHAKE_PURPOSES: RpcPurpose[] = ["initialize", "session_new", "set_effort"];

/** Typed access to the workflow's task, model usage, rpc, and prompt queue tables. */
export class WorkflowStore extends WorkflowRowStore {
  private readonly taskById = this.db
    .select()
    .from(tasks)
    .where(eq(tasks.task_id, sql.placeholder("taskId")))
    .prepare();
  private readonly allTasks = this.db.select().from(tasks).orderBy(tasks.started_at).prepare();
  private readonly activeJobTasks = this.db
    .select()
    .from(tasks)
    .where(and(notInArray(tasks.status, FINISHED_TASK_STATUSES), inArray(tasks.role, JOB_ROLES)))
    .orderBy(tasks.started_at)
    .prepare();
  private readonly refinerRunsOfJob = this.db
    .select({ task: tasks, review: reviews, ruling: rulings })
    .from(tasks)
    .leftJoin(reviews, eq(reviews.task_id, tasks.task_id))
    .leftJoin(rulings, eq(rulings.task_id, tasks.task_id))
    .where(and(eq(tasks.job_id, sql.placeholder("jobId")), inArray(tasks.role, REFINER_ROLES)))
    .orderBy(tasks.started_at)
    .prepare();
  private readonly rulingOfTask = this.db
    .select()
    .from(rulings)
    .where(eq(rulings.task_id, sql.placeholder("taskId")))
    .prepare();
  private readonly taskOfJobInRole = this.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.job_id, sql.placeholder("jobId")), eq(tasks.role, sql.placeholder("role"))))
    .prepare();
  private readonly jobById = this.db
    .select()
    .from(jobs)
    .where(eq(jobs.job_id, sql.placeholder("jobId")))
    .prepare();
  private readonly allJobs = this.db.select().from(jobs).orderBy(jobs.created_at).prepare();
  private readonly sandboxOfTask = this.db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.task_id, sql.placeholder("taskId")))
    .prepare();
  private readonly handshakeOfTask = this.db
    .select({ id: rpc.id })
    .from(rpc)
    .where(
      and(eq(rpc.task_id, sql.placeholder("taskId")), inArray(rpc.purpose, HANDSHAKE_PURPOSES)),
    )
    .limit(1)
    .prepare();
  private readonly allQueued = this.db.select().from(promptQueue).orderBy(promptQueue.id).prepare();

  task(taskId: string): TaskRow | null {
    return this.taskById.get({ taskId }) ?? null;
  }

  /** The task, or throw. For code paths that just wrote the row. */
  requireTask(taskId: string): TaskRow {
    const task = this.task(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  tasks(): TaskRow[] {
    return this.allTasks.all();
  }

  /** How many tasks the workflow started. The store never deletes a task, so it numbers the next. */
  taskCount(): number {
    return this.db.select({ total: count() }).from(tasks).get()?.total ?? 0;
  }

  /**
   * Unfinished author and researcher tasks, oldest first. Each one holds a slot for its job.
   * Refiner runs are left out.
   */
  activeAuthorAndResearcherTasks(): TaskRow[] {
    return this.activeJobTasks.all();
  }

  /** Reviewer and polisher runs that have not finished, oldest first. */
  activeRefinerRuns(): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(notInArray(tasks.status, FINISHED_TASK_STATUSES), inArray(tasks.role, REFINER_ROLES)),
      )
      .orderBy(tasks.started_at)
      .all();
  }

  /** Every refiner run ever started in one job, oldest first, with what each one filed. */
  refinerRunsOf(jobId: string): RefinerRun[] {
    return this.refinerRunsOfJob.all({ jobId }).map((row) => ({
      ...row.task,
      review: row.review && reviewOf(row.review),
      ruling: row.ruling && rulingStateOf(row.ruling),
    }));
  }

  /** File the review a findings reviewer run left on the host. */
  fileReview(taskId: string, review: Review): void {
    this.db
      .insert(reviews)
      .values({ task_id: taskId, ...review })
      .run();
  }

  /** Where the ruling on a judge run stands. Null while it is not decided and no person is asked. */
  ruling(taskId: string): RulingState | null {
    const row = this.rulingOfTask.get({ taskId });
    return row ? rulingStateOf(row) : null;
  }

  /** Record where the ruling on a judge run stands. A ruling replaces the ask for a person's ruling. */
  recordRuling(taskId: string, ruling: RulingState): void {
    const row = { task_id: taskId, revision: null, reason: null, ...ruling };
    this.db
      .insert(rulings)
      .values(row)
      .onConflictDoUpdate({ target: rulings.task_id, set: row })
      .run();
  }

  /** The author task of a job. Null while the job has not started one yet. */
  authorTask(jobId: string): TaskRow | null {
    return this.taskOfJobInRole.get({ jobId, role: "author" }) ?? null;
  }

  /** The author task, or throw. For a job that has an artifact or a refiner run. */
  authorTaskOf(jobId: string): TaskRow {
    const author = this.authorTask(jobId);
    if (!author) throw new Error(`job ${jobId} has no author task`);
    return author;
  }

  /**
   * The task that holds the job: its author, or its researcher while no author has started.
   * Every job starts with one of them, so a missing one throws.
   */
  authorOrResearcherTaskOf(jobId: string): TaskRow {
    const task = this.authorTask(jobId) ?? this.researcherTask(jobId);
    if (!task) throw new Error(`job ${jobId} has no author or researcher task`);
    return task;
  }

  /** The researcher task of a job. Null on a stage without research. */
  researcherTask(jobId: string): TaskRow | null {
    return this.taskOfJobInRole.get({ jobId, role: "researcher" }) ?? null;
  }

  job(jobId: string): JobRow | null {
    return this.jobById.get({ jobId }) ?? null;
  }

  /** The job, or throw. For a job id read from a task row. */
  requireJob(jobId: string): JobRow {
    const job = this.job(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    return job;
  }

  jobs(): JobRow[] {
    return this.allJobs.all();
  }

  /** How many jobs the workflow started. The store never deletes a job, so it numbers the next. */
  jobCount(): number {
    return this.db.select({ total: count() }).from(jobs).get()?.total ?? 0;
  }

  /** The job whose pull request lives on this branch, if any. */
  jobByBranch(branch: string): JobRow | null {
    return this.db.select().from(jobs).where(eq(jobs.branch, branch)).get() ?? null;
  }

  /** The newest job on a tracker issue, if any. */
  jobByIssue(issueId: string): JobRow | null {
    return (
      this.db
        .select()
        .from(jobs)
        .where(eq(jobs.issue_id, issueId))
        .orderBy(desc(jobs.created_at))
        .get() ?? null
    );
  }

  insertJob(job: NewJob): void {
    this.db
      .insert(jobs)
      .values({ ...job, created_at: now() })
      .run();
  }

  /** Store what the job's researcher found. */
  updateJobResearchPayload(jobId: string, payload: string): void {
    this.db.update(jobs).set({ research_payload: payload }).where(eq(jobs.job_id, jobId)).run();
  }

  /** Store the option a person chose on a stage with a choice ending. */
  updateJobSelection(jobId: string, selection: string): void {
    this.db.update(jobs).set({ selection }).where(eq(jobs.job_id, jobId)).run();
  }

  /** Insert a task, and its sandbox row unless it is a model-call task. */
  insertTask(task: NewTask): void {
    const at = now();
    this.db
      .insert(tasks)
      .values({
        task_id: task.task_id,
        job_id: task.job_id,
        role: task.role,
        refiner_index: "refiner_index" in task ? task.refiner_index : null,
        model: task.model,
        status: "queued",
        started_at: at,
      })
      .run();
    if (!task.sandbox) return;
    this.db
      .insert(sandboxes)
      .values({ ...task.sandbox, task_id: task.task_id, last_progress_at: at })
      .run();
  }

  /** Patch columns of one task. */
  updateTask(taskId: string, patch: Partial<TaskRow>): void {
    if (Object.keys(patch).length === 0) return;
    this.db.update(tasks).set(patch).where(eq(tasks.task_id, taskId)).run();
  }

  /** The sandbox row of a task. Null for a model-call task. */
  sandbox(taskId: string): SandboxRow | null {
    return this.sandboxOfTask.get({ taskId }) ?? null;
  }

  /** The sandbox row of a task, or throw. For code paths that act on a harness task. */
  requireSandbox(taskId: string): SandboxRow {
    const sandbox = this.sandbox(taskId);
    if (!sandbox) throw new Error(`sandbox of task ${taskId} not found`);
    return sandbox;
  }

  /** Patch columns of the sandbox row of one task. */
  updateSandbox(taskId: string, patch: Partial<SandboxRow>): void {
    if (Object.keys(patch).length === 0) return;
    this.db.update(sandboxes).set(patch).where(eq(sandboxes.task_id, taskId)).run();
  }

  /** Append streamed text to the turn buffer and keep only its tail. */
  appendTurnText(taskId: string, text: string): void {
    const row = this.db
      .select({ turn_text: sandboxes.turn_text })
      .from(sandboxes)
      .where(eq(sandboxes.task_id, taskId))
      .get();
    if (!row) return;
    const turnText = (row.turn_text + text).slice(-TURN_TEXT_CHARS);
    this.updateSandbox(taskId, { turn_text: turnText });
  }

  recordModelUsage(usage: NewModelUsage): void {
    this.db
      .insert(modelUsage)
      .values({ ...usage, at: now() })
      .run();
  }

  /**
   * What the workflow cost so far: the orchestrator's own calls plus what every harness reported.
   * A provider that reports no cost leaves the figure a floor.
   */
  workflowCost(): number {
    const calls = this.db.select({ cost_usd: modelUsage.cost_usd }).from(modelUsage).all();
    const harnesses = this.db.select({ cost_usd: tasks.cost_usd }).from(tasks).all();
    return [...calls, ...harnesses].reduce((total, row) => total + row.cost_usd, 0);
  }

  modelUsage(): ModelUsageRow[] {
    return this.db.select().from(modelUsage).orderBy(modelUsage.id).all();
  }

  /** Input tokens the provider reported for the last agent turn request, or 0 when none has. */
  lastTurnInputTokens(): number {
    const row = this.db
      .select({ input_tokens: modelUsage.input_tokens })
      .from(modelUsage)
      .where(eq(modelUsage.purpose, TURN_PURPOSE))
      .orderBy(desc(modelUsage.id))
      .limit(1)
      .get();
    return row?.input_tokens ?? 0;
  }

  /** Allocate a request id the store never gave before and remember why it was sent. */
  insertRpc(taskId: string, method: string, purpose: RpcPurpose): number {
    const inserted = this.db
      .insert(rpc)
      .values({ task_id: taskId, method, purpose, sent_at: now() })
      .returning({ id: rpc.id })
      .get();
    return inserted.id;
  }

  /** Remove and return the pending request, or null if the id is unknown for this task. */
  takeRpc(id: number, taskId: string): PendingRpc | null {
    const pending = this.db
      .select({ purpose: rpc.purpose, method: rpc.method })
      .from(rpc)
      .where(and(eq(rpc.id, id), eq(rpc.task_id, taskId)))
      .get();
    if (!pending) return null;
    this.db.delete(rpc).where(eq(rpc.id, id)).run();
    return pending;
  }

  clearRpc(taskId: string): void {
    this.db.delete(rpc).where(eq(rpc.task_id, taskId)).run();
  }

  /** True while a request sent before the first prompt awaits its response. */
  handshakePending(taskId: string): boolean {
    return this.handshakeOfTask.get({ taskId }) !== undefined;
  }

  enqueuePrompt(taskId: string, text: string): void {
    this.db.insert(promptQueue).values({ task_id: taskId, text, created_at: now() }).run();
  }

  /** Queue a prompt ahead of every prompt that waits. */
  enqueuePromptFirst(taskId: string, text: string): void {
    const head = this.db
      .select({ id: promptQueue.id })
      .from(promptQueue)
      .orderBy(promptQueue.id)
      .limit(1)
      .get();
    const id = head ? head.id - 1 : undefined;
    this.db.insert(promptQueue).values({ id, task_id: taskId, text, created_at: now() }).run();
  }

  peekPrompt(taskId: string): QueuedPrompt | null {
    return (
      this.db
        .select({ id: promptQueue.id, text: promptQueue.text })
        .from(promptQueue)
        .where(eq(promptQueue.task_id, taskId))
        .orderBy(promptQueue.id)
        .limit(1)
        .get() ?? null
    );
  }

  dequeuePrompt(id: number): void {
    this.db.delete(promptQueue).where(eq(promptQueue.id, id)).run();
  }

  /** Drop every queued prompt of a task. For teardown. */
  clearPromptQueue(taskId: string): void {
    this.db.delete(promptQueue).where(eq(promptQueue.task_id, taskId)).run();
  }

  /** The session feed of an author. Null before its first turn or narration in a job session. */
  sessionFeed(taskId: string): SessionFeedRow | null {
    return (
      this.db.select().from(sessionFeeds).where(eq(sessionFeeds.task_id, taskId)).get() ?? null
    );
  }

  /** The feed showed activity at `at`: a post, or the start of a turn. */
  touchSessionFeed(taskId: string, at: string): void {
    this.db
      .insert(sessionFeeds)
      .values({ task_id: taskId, active_at: at })
      .onConflictDoUpdate({ target: sessionFeeds.task_id, set: { active_at: at } })
      .run();
  }

  /** Add a narration line after the lines that wait for their post. */
  appendNarration(taskId: string, line: string, at: string): void {
    const waiting = this.sessionFeed(taskId)?.narration ?? "";
    const narration = waiting ? `${waiting}${NARRATION_LINE_SEPARATOR}${line}` : line;
    this.db
      .insert(sessionFeeds)
      .values({ task_id: taskId, narration, active_at: at })
      .onConflictDoUpdate({ target: sessionFeeds.task_id, set: { narration } })
      .run();
  }

  /** Narration posted at `at`. The lines it carried stop waiting, and both feed clocks move. */
  recordNarrationPost(taskId: string, posted: string, at: string): void {
    const waiting = this.sessionFeed(taskId)?.narration ?? "";
    const rest = waiting.startsWith(posted) ? waiting.slice(posted.length) : waiting;
    const narration = rest.startsWith(NARRATION_LINE_SEPARATOR)
      ? rest.slice(NARRATION_LINE_SEPARATOR.length)
      : rest;
    this.db
      .update(sessionFeeds)
      .set({ narration, narrated_at: at, active_at: at })
      .where(eq(sessionFeeds.task_id, taskId))
      .run();
  }

  queue(): (typeof promptQueue.$inferSelect)[] {
    return this.allQueued.all();
  }
}
