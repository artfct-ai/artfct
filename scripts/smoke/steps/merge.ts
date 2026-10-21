/**
 * Step 5. Merging the PR closes the task and the workflow, completes the Linear issue, and
 * destroys the sandbox. A workflow that started in Linear addressed nothing to the chat.
 */
import {
  artifactOf,
  fetchConversationDebug,
  hasOutboxMessage,
  taskById,
  waitUntil,
  type ConversationDebug,
} from "../admin";
import { assert, assertEqual } from "../assert";
import { STAGE_NAMES } from "../config";
import { mergedPullRequest, pullRequestEvent, pullRequestFixture, samFixture } from "../fixtures";
import { waitForSandboxDestroyed } from "../sandbox";
import { postGithubWebhook } from "../webhooks";

/** Inputs for the merge step. `branch` is the head ref the task pushed to. */
export type MergeOptions = { conversationId: string; taskId: string; branch: string };

/** Closes the PR as merged and waits for the workflow to finish. Returns the final dump. */
async function mergePr(options: MergeOptions): Promise<ConversationDebug> {
  const { conversationId, taskId, branch } = options;
  await postGithubWebhook(
    "pull_request",
    pullRequestEvent("closed", mergedPullRequest(pullRequestFixture(branch)), samFixture),
  );
  const done = await waitUntil({ label: "workflow done and linear issue completed" }, async () => {
    const debug = await fetchConversationDebug(conversationId);
    const finished =
      debug.workflow?.status === "ended" &&
      debug.workflow_end?.ends_as === "done" &&
      taskById(debug, taskId).status === "done" &&
      hasOutboxMessage(
        debug,
        (message) => message.kind === "issue_update" && message.payload.to === "completed",
      );
    return finished ? debug : null;
  });
  assertEqual(
    artifactOf(done, taskById(done, taskId).job_id)?.status,
    "accepted",
    "artifact status",
  );
  assertEqual(
    done.jobs.map((job) => {
      const author = done.tasks.find(
        (task) => task.job_id === job.job_id && task.role === "author",
      );
      return `${job.stage}:${author?.status}`;
    }),
    STAGE_NAMES.map((stage) => `${stage}:done`),
    "one done job per stage",
  );
  assertEqual(
    done.tasks.filter((task) => task.role !== "author" && task.status !== "done").length,
    0,
    "every reviewer and polisher run is done too",
  );
  assertEqual(done.queue.length, 0, "no prompt left in the task queue");

  const exit = await waitForSandboxDestroyed(taskId, "sandbox destroyed after completion");
  if (exit) assert(exit.code === 0 || exit.killed, "bridge exited cleanly", exit);
  return done;
}

/** A workflow the tracker started narrates itself there. The chat never hears about it. */
function assertNothingOnChat(last: ConversationDebug): void {
  assert(
    !hasOutboxMessage(last, (message) => message.channel === "chat"),
    "the Linear workflow addressed no chat message from its first event to its last",
    last.outbox.filter((message) => message.channel === "chat"),
  );
}

/** Runs step 5 and returns the final debug dump for the summary line. */
export async function runMerge(options: MergeOptions): Promise<ConversationDebug> {
  console.log("\n5. Merge");
  const done = await mergePr(options);
  assertNothingOnChat(done);
  return done;
}
