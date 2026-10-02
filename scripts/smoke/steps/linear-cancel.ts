/**
 * Step 10. The workflow's own issue moves to Canceled in Linear. The workflow ends, its task
 * is cancelled, and the sandbox is destroyed.
 */
import { fetchWorkflowDebug, hasOutboxMessage, outboxText, taskById, waitUntil } from "../admin";
import { assert } from "../assert";
import type { CreatedWorkflow } from "../create";
import {
  issueStateChanged,
  LINEAR_CANCELED_STATE,
  LINEAR_TEAM_STATES,
  linearDev,
} from "../fixtures";
import { assertStartsSince, startCountBaseline, waitForSandboxDestroyed } from "../sandbox";
import { postLinearWebhook } from "../webhooks";
import { THIRD_ISSUE } from "./bridge-loss";

/** Runs step 10 on the workflow step 9 left running. */
export async function runLinearCancel(options: CreatedWorkflow): Promise<void> {
  const { workflowId, taskId } = options;
  console.log("\n10. Linear issue canceled");
  const startsBefore = await startCountBaseline(taskId);
  const startedState = LINEAR_TEAM_STATES.find((state) => state.type === "started")!;

  const reply = await postLinearWebhook(
    issueStateChanged({
      issue: THIRD_ISSUE,
      from: startedState,
      to: LINEAR_CANCELED_STATE,
      actor: linearDev,
    }),
    "Issue",
  );
  assert(!("ignored" in reply), "the issue move was delivered as an event", reply);

  const cancelled = await waitUntil({ label: "workflow cancelled from the issue" }, async () => {
    const debug = await fetchWorkflowDebug(workflowId);
    const done =
      debug.state.status === "cancelled" && taskById(debug, taskId).status === "cancelled";
    return done ? debug : null;
  });
  assert(
    hasOutboxMessage(
      cancelled,
      (message) =>
        message.channel === "tracker" &&
        message.kind === "response" &&
        outboxText(message).startsWith("Cancelled."),
    ),
    "cancellation posted to the Linear session",
    cancelled.outbox,
  );
  const exit = await waitForSandboxDestroyed(taskId, "/destroy reached the mock sandbox");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  await assertStartsSince(startsBefore, 0, "no restart after the cancel", taskId);
}
