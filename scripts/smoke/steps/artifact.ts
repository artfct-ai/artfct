/**
 * Step 3. The PR stage prints a PR URL. The orchestrator records it as the task artifact and
 * binds the PR and branch, but holds the announcement until the code review settles.
 * This step releases the held reviewer and reads the state on both sides of that release.
 */
import {
  artifactOf,
  countLogLines,
  countTaskLogLines,
  countTurns,
  fetchBindings,
  fetchConversationDebug,
  handedOverLine,
  isRefinerRun,
  logLinesBetween,
  hasOutboxMessage,
  outboxText,
  taskById,
  waitUntil,
  type ConversationDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { authorTurnsThrough, REPO_FULL_NAME, STAGE_NAMES } from "../config";
import { PR_STAGE_NAME } from "../../../packages/orchestrator/test/smoke-config";
import { PULL_REQUEST_URL } from "../fixtures";
import { releaseMockReview } from "../harness";
import { waitForSandboxDestroyed } from "../sandbox";

/** The log line the author's task gets when a stage with refiners records its artifact. */
const HELD_LINE = "holding the announcement until the review settles";

/** Runs step 3 for the PR stage task started in step 2. */
export async function runArtifactFromAgentOutput(options: {
  conversationId: string;
  taskId: string;
  branch: string;
}): Promise<void> {
  const { conversationId, taskId, branch } = options;
  console.log("\n3. Artifact from agent output");

  const withPr = await waitUntil(
    { label: "artifact recorded from agent output, held, and the author's turn ended" },
    async () => {
      const debug = await fetchConversationDebug(conversationId);
      const task = taskById(debug, taskId);
      const recorded = artifactOf(debug, task.job_id)?.external_url === PULL_REQUEST_URL;
      const held = countTaskLogLines(debug, taskId, HELD_LINE) > 0;
      const ended =
        task.status === "in_review" && countTurns(debug) >= authorTurnsThrough(PR_STAGE_NAME);
      return recorded && held && ended ? debug : null;
    },
  );
  const artifact = artifactOf(withPr, taskById(withPr, taskId).job_id)!;
  assertEqual(withPr.artifacts.length, STAGE_NAMES.length, "one artifact per stage");
  assertEqual(artifact.kind, "pull", "artifact kind");
  assertEqual(artifact.status, "drafted", "the artifact is held back until the review settles");
  assertEqual(
    countTurns(withPr),
    authorTurnsThrough(PR_STAGE_NAME),
    "one harness turn per stage, plus the one the reviewed stage spent on its findings",
  );

  await releaseMockReview();
  const released = await waitForReview(conversationId, taskId);
  assert(
    hasOutboxMessage(
      released,
      (message) =>
        message.channel === "tracker" &&
        message.kind === "response" &&
        outboxText(message).includes(PULL_REQUEST_URL),
    ),
    "linear response links the PR",
    released.outbox,
  );

  const bindings = await fetchBindings();
  const ours = bindings.filter((binding) => binding.conversation_id === conversationId);
  assert(
    ours.some(
      (binding) => binding.source === "code_pull" && binding.external_id === `${REPO_FULL_NAME}#1`,
    ),
    "pull binding exists",
    ours,
  );
  assert(
    ours.some(
      (binding) =>
        binding.source === "code_branch" && binding.external_id === `${REPO_FULL_NAME}:${branch}`,
    ),
    "github_branch binding exists",
    ours,
  );
}

/**
 * Waits for the PR stage's refiners to release the artifact. They produce no artifact of their
 * own, and each one's sandbox is destroyed. Returns the dump taken once the humans were told.
 */
async function waitForReview(conversationId: string, taskId: string): Promise<ConversationDebug> {
  const released = await waitUntil(
    { label: "the refiners settled and released the artifact" },
    async () => {
      const debug = await fetchConversationDebug(conversationId);
      return artifactOf(debug, taskById(debug, taskId).job_id)?.status === "ready" ? debug : null;
    },
  );
  const jobId = taskById(released, taskId).job_id;
  assertEqual(released.artifacts.length, STAGE_NAMES.length, "no refiner run added an artifact");
  assertEqual(countLogLines(released, handedOverLine(jobId)), 1, "the loop closed once");
  const handover = `The pull request is ready for you: ${artifactOf(released, jobId)?.external_url}`;
  const ready = released.outbox.find((message) => outboxText(message) === handover);
  assert(ready !== undefined, "the humans hear the one line the pull kind wrote", released.outbox);
  const held = logLinesBetween(released, "artifact pull", handedOverLine(jobId));
  assertEqual(
    held.filter((line) => line.startsWith("agent turn started")).length,
    0,
    "no orchestrator turn while the refiners held the artifact",
  );
  const refinerRuns = released.tasks.filter((task) => task.job_id === jobId && isRefinerRun(task));
  for (const run of refinerRuns) {
    await waitForSandboxDestroyed(run.task_id, "refiner sandbox destroyed");
  }
  return released;
}
