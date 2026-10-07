/**
 * Step 4. The job boards. One board message per job per channel, edited in place, with no link,
 * CI result or merge state in its text. A follow-up moves a board to a new message.
 * Between a job's launch and its artifact, no message reaches a channel.
 */
import {
  artifactOf,
  countOutboxMessages,
  fetchWorkflowDebug,
  isRefinerRun,
  jobById,
  outboxText,
  type WorkflowDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import {
  PR_POLISHERS,
  PR_REVIEWERS,
  PR_STAGE_NAME,
} from "../../../packages/orchestrator/test/smoke-config";

type OutboxMessage = WorkflowDebug["outbox"][number];

/** The one line the mock sends back on a request. The same text as `ACK_TEXT` in the mock model. */
const ACK_TEXT = "Got it. Launching an agent now.";

/** How the review used to narrate itself to a channel. No message may read like this now. */
const REVIEW_NARRATION = /A review is starting|The review (found|posted)/;

/** Words the board must never show: links, CI results, and review or merge states. */
const LEAK = /http|\bCI\b|approved|changes requested|merged/i;

/** The line every reviewed stage's board shows for the handover to the humans. */
const HUMANS_LINE = "Ready for Humans";

/** A checklist line's text with its checkbox and its open-phase suffix taken off. */
const CHECKLIST_LINE = /^(?:☐|☑|- \[[ x]\]) (.+?)(?: ← .*)?$/;

/**
 * Rows on a human channel that report nothing about the task: an issue state move, a failed
 * call, and a release. None of these read as progress.
 */
const SILENT_KINDS = ["issue_update", "delivery_error", "release", "working"];

/** A message a human reads in Slack, Linear, or Notion. */
function reachesHumans(message: OutboxMessage): boolean {
  if (SILENT_KINDS.includes(message.kind)) return false;
  return (
    message.channel === "chat" || message.channel === "tracker" || message.channel === "documents"
  );
}

/** Runs step 4 over the whole workflow so far. */
export async function runBoardChecks(options: { workflowId: string }): Promise<void> {
  console.log("\n4. Boards");
  const debug = await fetchWorkflowDebug(options.workflowId);
  const creates = countOutboxMessages(
    debug,
    (message) => message.channel === "board" && message.kind === "create",
  );
  const moves = countOutboxMessages(
    debug,
    (message) => message.channel === "board" && message.kind === "delete",
  );
  assertEqual(
    creates,
    debug.boards.length + moves,
    "one board create per job and channel, and one per follow-up move",
  );
  assertAckFirst(debug);
  for (const task of debug.tasks) {
    if (task.role !== "author") continue;
    assertBoardLive(debug, task.job_id);
    assertQuietWindow(debug, task);
  }
  assertRefinersRan(debug);
  assertReviewOnChecklist(debug);
  assertReviewLoopSilent(debug);
  assertBoardEditedInPlace(debug);
  const leaked = debug.outbox
    .filter((message) => message.channel === "board")
    .map(outboxText)
    .filter((text) => LEAK.test(text));
  assertEqual(leaked.length, 0, "board text holds no link, CI result, review, or merge state");
}

/** Reviewers and polishers ran. */
function assertRefinersRan(debug: WorkflowDebug): void {
  const roles = new Set(debug.tasks.map((task) => task.role));
  assert(roles.has("reviewer"), "a reviewer run ran", debug.tasks);
  assert(roles.has("polisher"), "a polisher run ran", debug.tasks);
}

/** Every job a refiner worked on has a board that carries its stage's phase lines. */
function assertReviewOnChecklist(debug: WorkflowDebug): void {
  const shown = jobsShowingPhases(debug);
  const reviewed = new Set(debug.tasks.filter(isRefinerRun).map((task) => task.job_id));
  for (const jobId of reviewed) {
    assert(shown.has(jobId), `${jobId}: board shows the phase lines and the humans line`, [
      ...shown,
    ]);
  }
  const named = boardEdits(debug)
    .flatMap((edit) => checklistLines(edit.text))
    .filter((line) => line !== "review" && [...PR_REVIEWERS, ...PR_POLISHERS].includes(line));
  assertEqual(named, [], "no board line names a refiner entry");
}

/**
 * The jobs whose board carried the phases their stage declares. The PR stage declares
 * reviewers and polishers, so it shows `review` and `polish`. The design stage shows `review`.
 */
function jobsShowingPhases(debug: WorkflowDebug): Set<string> {
  const shown = new Set<string>();
  for (const edit of boardEdits(debug)) {
    const phases =
      jobById(debug, edit.jobId).stage === PR_STAGE_NAME ? ["review", "polish"] : ["review"];
    const lines = checklistLines(edit.text);
    if ([...phases, HUMANS_LINE].every((line) => lines.includes(line))) shown.add(edit.jobId);
  }
  return shown;
}

/**
 * Every board edit with the job it belongs to. An edit names the message it rewrote and a
 * board row holds that message id with its job.
 */
function boardEdits(debug: WorkflowDebug): Array<{ jobId: string; text: string }> {
  const jobOfMessage = new Map<string, string>();
  for (const board of debug.boards) {
    if (board.message_id) jobOfMessage.set(board.message_id, board.job_id);
  }
  const edits: Array<{ jobId: string; text: string }> = [];
  for (const message of debug.outbox) {
    if (message.channel !== "board" || message.kind !== "edit") continue;
    const jobId = jobOfMessage.get(String(message.payload.messageId));
    if (jobId) edits.push({ jobId, text: outboxText(message) });
  }
  return edits;
}

/** What each checklist line of a board says, in order. */
function checklistLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => CHECKLIST_LINE.exec(line)?.[1])
    .filter((line) => line !== undefined);
}

/** A reviewer starting says nothing to a channel. The board carries the run on its own. */
function assertReviewLoopSilent(debug: WorkflowDebug): void {
  const spoken = debug.outbox.filter(
    (message) => reachesHumans(message) && REVIEW_NARRATION.test(outboxText(message)),
  );
  assertEqual(
    spoken.map(outboxText),
    [],
    "the channels hear nothing about a review starting or what it found",
  );
}

/** Every board of the job reached its channel and still holds its message. */
function assertBoardLive(debug: WorkflowDebug, jobId: string): void {
  const boards = debug.boards.filter((board) => board.job_id === jobId);
  assert(boards.length >= 1, `${jobId}: board posted`, debug.boards);
  for (const board of boards) {
    assert(board.message_id !== null, `${jobId}: board on ${board.channel_key} is live`, board);
  }
}

/** The workflow edited a board in place at least once, and reposted none. */
function assertBoardEditedInPlace(debug: WorkflowDebug): void {
  const edits = countOutboxMessages(
    debug,
    (message) => message.channel === "board" && message.kind === "edit",
  );
  assert(edits >= 1, "a board was edited in place", edits);
}

/** Before the first board, the requester heard the one line back and nothing else. */
function assertAckFirst(debug: WorkflowDebug): void {
  const firstBoard = debug.outbox.findIndex((message) => message.channel === "board");
  assert(firstBoard >= 0, "a board was posted", debug.outbox.slice(0, 5));
  const heard = debug.outbox.slice(0, firstBoard).filter(reachesHumans).map(outboxText);
  assertEqual(heard, [ACK_TEXT], "one line back before the first board, nothing else");
}

/**
 * From the harness's first permission request to the artifact announcement, nothing reached a
 * channel at all. The permission line marks the harness at work, after the launch reply. On a
 * stage with research the researcher's harness starts the work.
 */
function assertQuietWindow(debug: WorkflowDebug, author: WorkflowDebug["tasks"][number]): void {
  const taskId = author.task_id;
  const artifact = artifactOf(debug, author.job_id);
  assert(artifact !== undefined, `${taskId}: artifact recorded`, debug.artifacts);
  const workers = new Set(
    debug.tasks
      .filter((task) => task.job_id === author.job_id)
      .filter((task) => task.role === "author" || task.role === "researcher")
      .map((task) => task.task_id),
  );
  const start = debug.log.find(
    (entry) => workers.has(entry.task_id ?? "") && entry.line.startsWith("permission:"),
  );
  assert(start !== undefined, `${taskId}: harness turn seen`, debug.log.slice(-5));
  const end = debug.outbox.find(
    (message) =>
      message.at >= start.at &&
      reachesHumans(message) &&
      outboxText(message).includes(artifact.external_url),
  );
  assert(end !== undefined, `${taskId}: artifact announced`, debug.outbox.slice(-5));
  const noisy = debug.outbox.filter(
    (message) => reachesHumans(message) && message.at >= start.at && message.at < end.at,
  );
  assert(
    noisy.length === 0,
    `${taskId}: no channel message between launch and artifact`,
    noisy.map((message) => ({ kind: message.kind, text: outboxText(message).slice(0, 120) })),
  );
}
