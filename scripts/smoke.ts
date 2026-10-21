#!/usr/bin/env bun
/**
 * End-to-end wiring check with mock event data. It drives the real Worker entrypoints, service
 * bindings, ingress routes, orchestrator, and mock vendors through the steps below, and asserts
 * on the Workflow DO debug dump and the mock vendor records. The Quint specs and the property
 * tests check workflow and agent behavior.
 * INGRESS_URL targets a live stack. SMOKE_VERBOSE=1 echoes every wrangler line.
 */
import { IS_EXTERNAL_INGRESS } from "./smoke/config";
import { installProcessHandlers, startHarness, stopHarness, verifyStack } from "./smoke/harness";
import { runArtifactFromAgentOutput } from "./smoke/steps/artifact";
import { runBoardChecks } from "./smoke/steps/board";
import { runGithubEvents } from "./smoke/steps/github";
import { runLinearCancel } from "./smoke/steps/linear-cancel";
import { runLinearInstall } from "./smoke/steps/linear-install";
import { runLinearStart } from "./smoke/steps/linear-start";
import { runMerge } from "./smoke/steps/merge";
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
  const { conversationId } = first;
  const { taskId, branch } = await step("2. Document stages", () =>
    runDocumentStages({ conversationId, taskId: first.taskId }),
  );
  await step("3. Artifact", () => runArtifactFromAgentOutput({ conversationId, taskId, branch }));
  await step("4. GitHub events", () => runGithubEvents({ conversationId, taskId, branch }));
  const done = await step("5. Merge", () => runMerge({ conversationId, taskId, branch }));
  await step("6. Linear issue canceled", runLinearCancel);
  const slack = await step("7. Slack", runSlack);
  await step("8. Boards", () => runBoardChecks(slack));

  console.log("\nSMOKE PASSED");
  const conversationLog = done.log.map((entry) => entry.line).join(" | ");
  console.log(`conversation ${conversationId}: ${conversationLog.slice(0, 1500)}`);
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
