/**
 * Step 9. A sandbox dies mid turn: the socket closes with a prompt in flight and the bridge
 * process is gone. The orchestrator asks the sandbox host, finds no bridge, forgets the turn,
 * and starts a new generation without waiting out the reconnect window.
 */
import {
  countTaskLogLines,
  countTurns,
  fetchWorkflowDebug,
  hasLogLine,
  taskById,
  waitForAgentIdle,
  waitForTurns,
  waitUntil,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { PAGE_PARENT_ID, REPO_FULL_NAME } from "../config";
import { createWorkflowFromIssue, type CreatedWorkflow } from "../create";
import { agentSessionPrompted, linearDev, linearIssue, linearSessionId } from "../fixtures";
import { killMockBridge } from "../harness";
import { assertStartsSince, latestStart, startCountBaseline } from "../sandbox";
import { postLinearWebhook } from "../webhooks";

/** The session and issue of the third workflow. Step 10 cancels it from the issue. */
export const FOURTH_SESSION = linearSessionId(4);
export const THIRD_ISSUE = linearIssue(
  3,
  "ENG-44",
  "Add a changelog",
  `Keep a changelog. Repo: https://github.com/${REPO_FULL_NAME}\nPage parent: ${PAGE_PARENT_ID}`,
);

/** Room for a loaded machine. The recovery itself does not wait for the reconnect window. */
const RECOVERY_TIMEOUT_MS = 60_000;

/** Runs step 9 and returns the workflow for step 10. */
export async function runBridgeLoss(): Promise<CreatedWorkflow> {
  console.log("\n9. Bridge loss");
  const created = await createWorkflowFromIssue({
    sessionId: FOURTH_SESSION,
    issue: THIRD_ISSUE,
    label: "third workflow",
  });
  const { workflowId, taskId } = created;
  await waitForTurns({ workflowId, baseline: 0, expected: 1, label: "first harness turn ended" });
  const idle = await waitForAgentIdle(workflowId);
  const permissions = countTaskLogLines(idle, taskId, "permission:");
  const startsBefore = await startCountBaseline(taskId);

  await postLinearWebhook(
    agentSessionPrompted({
      sessionId: FOURTH_SESSION,
      creator: linearDev,
      issue: THIRD_ISSUE,
      body: "Polish the wording. Never finish this turn.",
    }),
  );
  await waitUntil({ label: "second prompt runs as a harness turn" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    return countTaskLogLines(debug, taskId, "permission:") > permissions ? debug : null;
  });

  await killMockBridge(taskId);
  await waitUntil(
    {
      label: "sandbox restarted and resumed after the bridge was lost",
      timeoutMs: RECOVERY_TIMEOUT_MS,
    },
    async () => {
      const debug = await fetchWorkflowDebug(workflowId);
      const restarted = hasLogLine(debug, "bridge lost with a prompt in flight");
      const resumeStarted = hasLogLine(debug, "sandbox started gen=2 resume=true");
      return restarted && resumeStarted && taskById(debug, taskId).sandbox?.generation === 2
        ? debug
        : null;
    },
  );
  await assertStartsSince(startsBefore, 1, "mock sandbox saw one restart", taskId);
  const start = await latestStart(taskId);
  if (start) assertEqual(start.generation, 2, "the restart is generation 2");

  const resumed = await waitUntil({ label: "resume turn ended on the new sandbox" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const helloed = countTaskLogLines(debug, taskId, "hello fresh=true") === 2;
    return helloed && countTurns(debug) === 2 ? debug : null;
  });
  assertEqual(resumed.queue.length, 0, "nothing left in the prompt queue");
  assert(
    ["working", "in_review"].includes(taskById(resumed, taskId).status),
    "task is active again",
    taskById(resumed, taskId),
  );
  return created;
}
