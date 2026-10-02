#!/usr/bin/env bun
/**
 * End-to-end smoke test with mock event data. It runs the steps below against a local stack
 * and asserts on the Workflow DO debug dump and the mock sandbox record.
 * INGRESS_URL targets a live stack. SMOKE_VERBOSE=1 echoes every wrangler line.
 */
import { IS_EXTERNAL_INGRESS } from "./smoke/config";
import { installProcessHandlers, startHarness, stopHarness, verifyStack } from "./smoke/harness";
import { runArtifactFromAgentOutput } from "./smoke/steps/artifact";
import { runBoardChecks } from "./smoke/steps/board";
import { runBridgeLoss } from "./smoke/steps/bridge-loss";
import { runContextBudget } from "./smoke/steps/budget";
import { runCancel } from "./smoke/steps/cancel";
import { runLinearCancel } from "./smoke/steps/linear-cancel";
import { runLinearInstall } from "./smoke/steps/linear-install";
import { runLinearStart } from "./smoke/steps/linear-start";
import { runMerge } from "./smoke/steps/merge";
import { runReviewLoop } from "./smoke/steps/review-loop";
import { runSlack } from "./smoke/steps/slack";
import { runDocumentStages } from "./smoke/steps/stages";

/** Runs one step, then checks wrangler output and bridge exits before moving on. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const result = await run();
  await verifyStack(label);
  return result;
}

/** Runs every scenario step in order and prints the final workflow log. */
async function main(): Promise<void> {
  if (!IS_EXTERNAL_INGRESS) await startHarness();

  await step("0. Linear install", runLinearInstall);
  const first = await step("1. Linear delegation", runLinearStart);
  const { workflowId } = first;
  const { taskId, branch } = await step("2. Document stages", () =>
    runDocumentStages({ workflowId, taskId: first.taskId }),
  );
  await step("3. Artifact", () => runArtifactFromAgentOutput({ workflowId, taskId, branch }));
  await step("4. Boards", () => runBoardChecks({ workflowId }));
  await step("5. Context budget", () => runContextBudget({ workflowId, taskId }));
  await step("6. Review loop", () => runReviewLoop({ workflowId, taskId, branch }));
  const done = await step("7. Merge", () => runMerge({ workflowId, taskId, branch }));
  await step("8. Cancel", runCancel);
  const third = await step("9. Bridge loss", runBridgeLoss);
  await step("10. Linear issue canceled", () => runLinearCancel(third));
  await step("11. Slack", runSlack);

  console.log("\nSMOKE PASSED");
  const workflowLog = done.log.map((entry) => entry.line).join(" | ");
  console.log(`workflow ${workflowId}: ${workflowLog.slice(0, 1500)}`);
}

const startedAt = Date.now();
installProcessHandlers();
main()
  .then(() => 0)
  .catch((error) => {
    console.error(`\nSMOKE FAILED: ${error instanceof Error ? error.stack : error}`);
    return 1;
  })
  .then(async (code) => {
    await stopHarness();
    console.log(`total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(
      `\nSMOKE FAILED: teardown: ${error instanceof Error ? error.stack : String(error)}`,
    );
    process.exit(1);
  });
