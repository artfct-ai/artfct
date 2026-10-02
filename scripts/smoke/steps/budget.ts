/**
 * Step 5. The context budget. Two prompts sent while the harness works run as two harness
 * turns without an orchestrator turn between them. The prompts re-open the released
 * artifact, so the refiners hold it again and the orchestrator is not woken.
 */
import {
  countLogLines,
  countTaskLogLines,
  countTurns,
  fetchWorkflowDebug,
  waitForAgentIdle,
  waitForRefinersReleased,
  waitUntil,
  type WorkflowDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { agentSessionPrompted, linearDev } from "../fixtures";
import { postLinearWebhook } from "../webhooks";
import { FIRST_ISSUE, FIRST_SESSION } from "./linear-start";

/** Wakes caused by the harness: a result, or idle with nothing queued. */
function countHarnessWakes(debug: WorkflowDebug): number {
  return countLogLines(debug, "agent wake: task_");
}

/**
 * The queued prompt reached the harness on its own: the author's second turn began before
 * any orchestrator turn ran, so no model call sat between the two turns.
 */
function assertQueuedWithoutModel(debug: WorkflowDebug, taskId: string): void {
  const ends = debug.log.flatMap((entry, index) =>
    entry.task_id === taskId && entry.line.startsWith("turn ended") ? [index] : [],
  );
  const [first, second] = ends.slice(-2);
  assert(first !== undefined && second !== undefined, "two harness turns in the log", ends);
  const between = debug.log
    .slice(first, second)
    .filter((entry) => entry.line.startsWith("agent turn started"));
  assertEqual(between.length, 0, "queued prompt sent without an orchestrator turn");
}

/** Sends one prompt on the first Linear session. */
function prompt(body: string) {
  return postLinearWebhook(
    agentSessionPrompted({
      sessionId: FIRST_SESSION,
      creator: linearDev,
      issue: FIRST_ISSUE,
      body,
    }),
  );
}

/** Runs step 5 on the PR task started in step 2. */
export async function runContextBudget(options: {
  workflowId: string;
  taskId: string;
}): Promise<void> {
  const { workflowId, taskId } = options;
  console.log("\n5. Context budget");
  const before = await waitForAgentIdle(workflowId);
  const turns = countTurns(before);
  const wakes = countHarnessWakes(before);
  const agentTurns = countLogLines(before, "agent turn started");
  const permissions = countTaskLogLines(before, taskId, "permission:");

  await prompt("Rename the helper. Take your time.");
  await waitUntil({ label: "first prompt runs as a harness turn" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return countTaskLogLines(debug, taskId, "permission:") > permissions ? debug : null;
  });
  await prompt("Also update the changelog.");

  const debug = await waitUntil({ label: "both prompts ended as harness turns" }, async () => {
    const dump = await fetchWorkflowDebug(workflowId);
    return countTurns(dump) === turns + 2 ? dump : null;
  });
  assertQueuedWithoutModel(debug, taskId);
  assertEqual(
    countHarnessWakes(debug),
    wakes,
    "no orchestrator wake: the re-opened artifact is held by the refiners again",
  );

  await waitForRefinersReleased(workflowId, taskId);
  const settled = await waitForAgentIdle(workflowId);
  assertEqual(countTurns(settled), turns + 2, "no further harness turn");
  assertEqual(
    countLogLines(settled, "agent turn started"),
    agentTurns + 2,
    "two prompts and no idle wake: two orchestrator turns",
  );
}
