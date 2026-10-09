import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { TaskRole } from "../task/events";
import { TURN_PURPOSE } from "../../agent/model/usage";
import { FeedStore } from "../feed/feed-store";
import { jobs, modelUsage, promptQueue, rpc, sandboxes, tasks } from "./schema";
import type { RpcPurpose } from "./schema";
import { FINISHED_TASK_STATUSES, now } from "./state";

export type { ArtifactRow, OutboxEntry } from "./records";
export type JobRow = typeof jobs.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type SandboxRow = typeof sandboxes.$inferSelect;
export type QueuedPrompt = Pick<typeof promptQueue.$inferSelect, "id" | "text">;
export type PendingRpc = Pick<typeof rpc.$inferSelect, "purpose" | "method">;
export type ModelUsageRow = typeof modelUsage.$inferSelect;
export type NewModelUsage = Omit<ModelUsageRow, "id" | "at">;

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
export type NewSandbox = Pick<SandboxRow, "harness" | "bridge_token">;

/**
 * Columns the caller sets when a task is created. Everything else has a default. A refiner run
 * names the refiner it runs. A model-call task has no sandbox.
 */
export type NewTask = Pick<TaskRow, "task_id" | "job_id" | "model"> & {
  sandbox: NewSandbox | null;
} & ({ role: "author" | "researcher" } | { role: "reviewer" | "polisher"; refiner_index: number });

/** How much of a turn's text is kept: enough for the summary, artifact scan, and report. */
export const TURN_TEXT_CHARS = 12_000;

const JOB_ROLES: TaskRole[] = ["author", "researcher"];
const REFINER_ROLES: TaskRole[] = ["reviewer", "polisher"];

const HANDSHAKE_PURPOSES: RpcPurpose[] = ["initialize", "session_new", "set_effort"];

/** Typed access to the workflow's task, model usage, rpc, and prompt queue tables. */
export class WorkflowStore extends FeedStore {
  task(taskId: string): TaskRow | null {
    return this.db.select().from(tasks).where(eq(tasks.task_id, taskId)).get() ?? null;
  }

  /** The task, or throw. For code paths that just wrote the row. */
  requireTask(taskId: string): TaskRow {
    const task = this.task(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  tasks(): TaskRow[] {
    return this.db.select().from(tasks).orderBy(tasks.started_at).all();
  }

  /**
   * Unfinished author and researcher tasks, oldest first. Each one holds a slot for its job.
   * Refiner runs are left out.
   */
  activeAuthorAndResearcherTasks(): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(and(notInArray(tasks.status, FINISHED_TASK_STATUSES), inArray(tasks.role, JOB_ROLES)))
      .orderBy(tasks.started_at)
      .all();
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

  /** Every refiner run ever started in one job, oldest first. */
  refinerRunsOf(jobId: string): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.job_id, jobId), inArray(tasks.role, REFINER_ROLES)))
      .orderBy(tasks.started_at)
      .all();
  }

  /** The author task of a job. Null while the job has not started one yet. */
  authorTask(jobId: string): TaskRow | null {
    return (
      this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.job_id, jobId), eq(tasks.role, "author")))
        .get() ?? null
    );
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
    const task =
      this.authorTask(jobId) ??
      this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.job_id, jobId), eq(tasks.role, "researcher")))
        .get();
    if (!task) throw new Error(`job ${jobId} has no author or researcher task`);
    return task;
  }

  job(jobId: string): JobRow | null {
    return this.db.select().from(jobs).where(eq(jobs.job_id, jobId)).get() ?? null;
  }

  /** The job, or throw. For a job id read from a task row. */
  requireJob(jobId: string): JobRow {
    const job = this.job(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    return job;
  }

  jobs(): JobRow[] {
    return this.db.select().from(jobs).orderBy(jobs.created_at).all();
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
    return this.db.select().from(sandboxes).where(eq(sandboxes.task_id, taskId)).get() ?? null;
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

  /** Allocate the next request id and remember why it was sent. */
  insertRpc(taskId: string, method: string, purpose: RpcPurpose): number {
    const last = this.db.select({ id: rpc.id }).from(rpc).orderBy(desc(rpc.id)).limit(1).get();
    const id = (last?.id ?? 0) + 1;
    this.db.insert(rpc).values({ id, task_id: taskId, method, purpose, sent_at: now() }).run();
    return id;
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
    const pending = this.db
      .select({ id: rpc.id })
      .from(rpc)
      .where(and(eq(rpc.task_id, taskId), inArray(rpc.purpose, HANDSHAKE_PURPOSES)))
      .limit(1)
      .get();
    return pending !== undefined;
  }

  enqueuePrompt(taskId: string, text: string): void {
    this.db.insert(promptQueue).values({ task_id: taskId, text, created_at: now() }).run();
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

  queue(): (typeof promptQueue.$inferSelect)[] {
    return this.db.select().from(promptQueue).orderBy(promptQueue.id).all();
  }
}
