import { tool } from "ai";
import { z } from "zod";
import { screenText, type Screened } from "../../decisions/screen";
import { feedbackText } from "../../prompts/review-prompt";
import { heldCommentFindings, heldCommentHandles } from "../../workflow/refiner/held-comments";
import { promptTask } from "../../workflow/task/harness/prompt-queue";
import { isTaskFinished } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";

/** The tool that sends the comments held on a page artifact to its author. */
export const SEND_HELD_COMMENTS = "send_held_comments";

/** How the agent sends the comments held on a page artifact. Kept next to the tool that sends them. */
export const HELD_COMMENT_RULES = `## Held Page Comments
* **Expect** a person's comment on a page artifact to be held. The author gets the held comments of a page together when a comment there mentions you.
* **Call** \`${SEND_HELD_COMMENTS}\` when a person in the thread asks for the page comments to go to the author, or asks the author to revise the page from them.
* **Prefer** \`${SEND_HELD_COMMENTS}\` over \`prompt_task\` for held comments. It carries their text and marks them read on the page.`;

/** True when the workflow has a page artifact, where comments can be held. */
export function hasPageArtifact(workflow: WorkflowRuntime): boolean {
  return workflow.store.artifacts().some(({ ref }) => ref.kind === "page");
}

/** The tool that sends held page comments to the author when a person asks in the thread. */
export function heldCommentTools(workflow: WorkflowRuntime, decisionsSignal?: AbortSignal) {
  return {
    [SEND_HELD_COMMENTS]: tool({
      description:
        "Send every comment held on a job's page artifact to its author as one prompt, the way a mention on the page does, and mark them read on the page. Refused when the job has no page artifact, no comment is held on it, or its author is finished.",
      inputSchema: z.object({
        job_id: z.string().describe("the job id, for example wf_abc-2"),
      }),
      execute: ({ job_id }) => sendHeldComments(workflow, job_id, decisionsSignal),
    }),
  };
}

/** What the model reads when the screen did not admit the held comments. It never holds them. */
export function unsentHeldCommentsText(
  pageUrl: string,
  screened: Exclude<Screened, "admitted">,
): string {
  const kept = "They stay held. Tell the person.";
  switch (screened) {
    case "quarantined":
      return `The held comments on ${pageUrl} were not sent. The screen found text in them that looks written to steer an AI agent. ${kept}`;
    case "unchecked":
      return `The held comments on ${pageUrl} were not sent. The screen could not check them right now. ${kept}`;
    case "too_large":
      return `The held comments on ${pageUrl} are too large to screen, so they were not sent. ${kept}`;
    default: {
      const unreachable: never = screened;
      throw new Error(`unhandled screen outcome ${String(unreachable)}`);
    }
  }
}

async function sendHeldComments(
  workflow: WorkflowRuntime,
  jobId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!workflow.store.job(jobId)) return `Job ${jobId} does not exist.`;
  const artifact = workflow.store.artifact(jobId);
  if (artifact?.ref.kind !== "page") {
    return `Job ${jobId} has no page artifact, so no comments are held for it.`;
  }
  const author = workflow.store.authorTaskOf(jobId);
  if (isTaskFinished(author.status)) {
    return `The author ${author.task_id} of job ${jobId} is ${author.status}, so nothing can be sent to it. The comments stay held.`;
  }
  const kind = workflow.artifact(artifact.kind);
  const comments = (await kind.heldComments?.read(artifact.ref.page_id)) ?? [];
  if (!comments.length) return `No comments are held on ${artifact.external_url}.`;
  const findings = heldCommentFindings(comments);
  const said = feedbackText("The people who commented on the page", { body: "", findings });
  const screened = await screenText(workflow, {
    source: `the held comments of job ${jobId}`,
    text: said,
    signal,
  });
  if (screened !== "admitted") return unsentHeldCommentsText(artifact.external_url, screened);
  await promptTask(workflow, author, said);
  await kind.acknowledge(heldCommentHandles(comments), artifact.ref);
  const count = `${comments.length} held comment${comments.length === 1 ? "" : "s"}`;
  return `Sent ${count} on ${artifact.external_url} to the author ${author.task_id}.`;
}
