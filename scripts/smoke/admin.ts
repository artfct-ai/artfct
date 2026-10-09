/**
 * Read helpers for the ingress admin endpoints plus the `waitUntil` polling loop that
 * every scenario step uses to observe workflow state.
 */
import { ADMIN_TOKEN, INGRESS_URL, stageHasRefiners } from "./config";

/** Shape of the Workflow DO debug dump served at `/admin/workflows/:id/debug`. */
export type WorkflowDebug = {
  state: {
    workflow_id: string;
    status: string;
    stages: string[];
    concurrency: number;
    repo: { full: string } | null;
    reply_targets: Array<{ source: string } & Record<string, unknown>>;
  };
  jobs: Array<{
    job_id: string;
    stage: string;
    issue_key: string | null;
    input_ref: { kind: string; page_id?: string } | null;
    input_url: string | null;
    branch: string | null;
    research_payload: string | null;
    selection: string | null;
  }>;
  tasks: Array<{
    task_id: string;
    job_id: string;
    status: string;
    role: string;
    refiner_index: number | null;
    summary: string;
    sandbox: { generation: number; restarts: number; session_id: string | null } | null;
  }>;
  artifacts: Array<{
    job_id: string;
    kind: string;
    external_url: string;
    status: string;
    refiner_task_id: string | null;
  }>;
  /** One row per job and channel the board is posted to. `message_id` is the message edited in place. */
  boards: Array<{
    job_id: string;
    channel_key: string;
    message_id: string | null;
    hash: string | null;
    recreated: number;
    relocate: number;
  }>;
  todos: Array<{ task_id: string; tool_calls: number; note: string | null }>;
  outbox: Array<{ at: string; channel: string; kind: string; payload: Record<string, unknown> }>;
  log: Array<{ at: string; task_id: string | null; line: string }>;
  queue: unknown[];
  /** Text queued for the agent since its last turn. Notes with wake `none` wait here. */
  inbox: Array<{ id: number; at: string; text: string; wake: string }>;
};

/** One row of `/admin/bindings`. Maps an external id to a workflow. */
export type Binding = { source: string; external_id: string; workflow_id: string };

/** Fetches an admin path and parses the JSON body. Throws on a non-2xx status. */
export async function adminGet<T>(path: string): Promise<T> {
  const response = await fetch(`${INGRESS_URL}/admin${path}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (!response.ok) throw new Error(`admin ${path} ${response.status}`);
  return (await response.json()) as T;
}

/** Fetches the debug dump for one workflow. */
export function fetchWorkflowDebug(workflowId: string): Promise<WorkflowDebug> {
  return adminGet<WorkflowDebug>(`/workflows/${workflowId}/debug`);
}

/** Fetches every binding row. */
export function fetchBindings(): Promise<Binding[]> {
  return adminGet<Binding[]>("/bindings");
}

/** True when any log line of the dump starts with `prefix`. */
export function hasLogLine(debug: WorkflowDebug, prefix: string): boolean {
  return debug.log.some((entry) => entry.line.startsWith(prefix));
}

/** Number of log lines of the dump that start with `prefix`. */
export function countLogLines(debug: WorkflowDebug, prefix: string): number {
  return debug.log.filter((entry) => entry.line.startsWith(prefix)).length;
}

/** Number of orchestrator agent turns that started. Every one costs a model call. */
export function countAgentTurns(debug: WorkflowDebug): number {
  return countLogLines(debug, "agent turn started");
}

/**
 * The log lines between the first line that starts with `from` and the first later line that
 * starts with `to`, both excluded. Throws when either is missing.
 */
export function logLinesBetween(debug: WorkflowDebug, from: string, to: string): string[] {
  const start = debug.log.findIndex((entry) => entry.line.startsWith(from));
  if (start < 0) throw new Error(`no log line starts with "${from}"`);
  const rest = debug.log.slice(start + 1);
  const end = rest.findIndex((entry) => entry.line.startsWith(to));
  if (end < 0) throw new Error(`no log line starts with "${to}" after "${from}"`);
  return rest.slice(0, end).map((entry) => entry.line);
}

/** Number of log lines of one task that start with `prefix`. */
export function countTaskLogLines(debug: WorkflowDebug, taskId: string, prefix: string): number {
  return debug.log.filter((entry) => entry.task_id === taskId && entry.line.startsWith(prefix))
    .length;
}

/** A reviewer or polisher run. */
export function isRefinerRun(task: WorkflowDebug["tasks"][number]): boolean {
  return task.role === "reviewer" || task.role === "polisher";
}

/** Task ids of the refiner runs in the dump: its reviewers and its polishers. */
export function refinerRunIds(debug: WorkflowDebug): string[] {
  return debug.tasks.filter(isRefinerRun).map((task) => task.task_id);
}

/**
 * The author task of the first job of a stage. Refiner runs take sequence numbers of their own,
 * so a stage's task id does not follow from its position in the plan.
 */
export function authorTaskOf(
  debug: WorkflowDebug,
  stage: string,
): WorkflowDebug["tasks"][number] | undefined {
  const job = debug.jobs.find((row) => row.stage === stage);
  return debug.tasks.find((task) => task.job_id === job?.job_id && task.role === "author");
}

/** The job row with the given id. Throws when the dump has none. */
export function jobById(debug: WorkflowDebug, jobId: string): WorkflowDebug["jobs"][number] {
  const job = debug.jobs.find((row) => row.job_id === jobId);
  if (!job) throw new Error(`job ${jobId} is not in the dump`);
  return job;
}

/** The reviewer runs of one job, oldest first. */
export function reviewersOf(
  debug: WorkflowDebug,
  jobId: string,
): Array<WorkflowDebug["tasks"][number]> {
  return debug.tasks.filter((task) => task.role === "reviewer" && task.job_id === jobId);
}

/** The polisher runs of one job, oldest first. */
export function polishersOf(
  debug: WorkflowDebug,
  jobId: string,
): Array<WorkflowDebug["tasks"][number]> {
  return debug.tasks.filter((task) => task.role === "polisher" && task.job_id === jobId);
}

/**
 * Number of harness turns that have ended for the workflow, refiner runs excluded. Every turn
 * assertion in the smoke counts the work the stages did, not the refiners over that work.
 */
export function countTurns(debug: WorkflowDebug): number {
  const refinerRuns = new Set(refinerRunIds(debug));
  return debug.log.filter(
    (entry) => entry.line.startsWith("turn ended") && !refinerRuns.has(entry.task_id ?? ""),
  ).length;
}

/**
 * Waits until the agent has read every note that wakes it. A turn end queues a note and wakes
 * the agent. An event posted before that turn runs would be read together with the note.
 */
export function waitForAgentIdle(workflowId: string): Promise<WorkflowDebug> {
  return waitUntil({ label: "agent inbox drained" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return debug.inbox.every((row) => row.wake === "none") ? debug : null;
  });
}

/** The log line the workflow writes when it hands a job's artifact to the humans. */
export function handedOverLine(jobId: string): string {
  return `the artifact of job ${jobId} is handed over`;
}

/**
 * Waits until the refiners handed the job's artifact to the humans after the author's latest
 * turn. An author turn on a released artifact makes it a draft again, and the refiners run and
 * hand it over once more.
 */
export function waitForRefinersReleased(
  workflowId: string,
  taskId: string,
): Promise<WorkflowDebug> {
  return waitUntil(
    { label: "the refiners released the artifact after the author's last turn" },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const jobId = taskById(debug, taskId).job_id;
      const lastTurn = debug.log.findLastIndex(
        (entry) => entry.task_id === taskId && entry.line.startsWith("turn ended"),
      );
      const handover = debug.log.findLastIndex((entry) => entry.line === handedOverLine(jobId));
      return artifactOf(debug, jobId)?.status === "ready" && handover > lastTurn ? debug : null;
    },
  );
}

/**
 * Waits until the humans have the job's artifact and the agent read what the workflow told it
 * since. The author of a stage without refiners tells the agent after the handover. The scripted
 * model answers only the last event it reads, so a reply read before that note is lost. A note
 * that wakes nobody waits in the inbox ahead of the reply and does no harm.
 */
export function waitForHandoverRead(workflowId: string, jobId: string): Promise<WorkflowDebug> {
  return waitUntil({ label: `the agent read the handover of ${jobId}` }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const handover = debug.log.findLastIndex((entry) => entry.line === handedOverLine(jobId));
    const ready = handover >= 0 && artifactOf(debug, jobId)?.status === "ready";
    const told =
      stageHasRefiners(jobById(debug, jobId).stage) ||
      debug.log.some((entry, index) => index > handover && entry.line.startsWith("agent wake:"));
    const read = debug.inbox.every((row) => row.wake === "none");
    return ready && told && read ? debug : null;
  });
}

/** Reads the current turn count. Steps take this baseline before they send an event. */
export async function turnBaseline(workflowId: string): Promise<number> {
  return countTurns(await fetchWorkflowDebug(workflowId));
}

/**
 * Waits until exactly `baseline + expected` turns have ended and returns the dump. More turns
 * than expected fail at once, because that means an event woke the harness twice.
 */
export function waitForTurns(options: {
  workflowId: string;
  baseline: number;
  expected: number;
  label: string;
}): Promise<WorkflowDebug> {
  const { workflowId, baseline, expected, label } = options;
  const target = baseline + expected;
  return waitUntil({ label: `${label} (turn ${target})`, timeoutMs: 15_000 }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const turns = countTurns(debug);
    if (turns > target) throw new Error(`${label}: expected ${target} turns, got ${turns}`);
    return turns === target ? debug : null;
  });
}

/** The task row with the given id. Throws when the dump has none. */
export function taskById(debug: WorkflowDebug, taskId: string): WorkflowDebug["tasks"][number] {
  const task = debug.tasks.find((row) => row.task_id === taskId);
  if (!task) throw new Error(`task ${taskId} is not in the dump`);
  return task;
}

/** The artifact of a job, or undefined when none is recorded. */
export function artifactOf(
  debug: WorkflowDebug,
  jobId: string,
): WorkflowDebug["artifacts"][number] | undefined {
  return debug.artifacts.find((row) => row.job_id === jobId);
}

/** The first outbox message matching `predicate`, or undefined. */
export function findOutboxMessage(
  debug: WorkflowDebug,
  predicate: (message: WorkflowDebug["outbox"][number]) => boolean,
): WorkflowDebug["outbox"][number] | undefined {
  return debug.outbox.find(predicate);
}

/** Number of outbox messages matching `predicate`. */
export function countOutboxMessages(
  debug: WorkflowDebug,
  predicate: (message: WorkflowDebug["outbox"][number]) => boolean,
): number {
  return debug.outbox.filter(predicate).length;
}

const NOT_SESSION_POSTS = ["issue_update", "attach_chat_thread", "delivery_error"];

/** Number of orchestrator posts on a tracker session. */
export function countSessionPosts(debug: WorkflowDebug): number {
  return countOutboxMessages(
    debug,
    (message) => message.channel === "tracker" && !NOT_SESSION_POSTS.includes(message.kind),
  );
}

/** True when the outbox holds a message matching `predicate`. */
export function hasOutboxMessage(
  debug: WorkflowDebug,
  predicate: (message: WorkflowDebug["outbox"][number]) => boolean,
): boolean {
  return debug.outbox.some(predicate);
}

/** The `body` or `text` of an outbox payload as a string. */
export function outboxText(message: WorkflowDebug["outbox"][number]): string {
  const text = message.payload.body ?? message.payload.text;
  return typeof text === "string" ? text : "";
}

/** Options for `waitUntil`. */
export type WaitUntilOptions = {
  /** Text printed on success and used in the timeout error. */
  label: string;
  /** Upper bound in milliseconds. Defaults to 20 seconds. */
  timeoutMs?: number;
};

/**
 * Polls `probe` every 250ms until it returns a truthy value, then logs an `ok` line with
 * the elapsed time and returns that value. Throws once `timeoutMs` has passed.
 */
export async function waitUntil<T>(
  options: WaitUntilOptions,
  probe: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const { label, timeoutMs = 20_000 } = options;
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      console.log(`  ok  ${label} (${Date.now() - startedAt}ms)`);
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${label}`);
    await Bun.sleep(250);
  }
}
