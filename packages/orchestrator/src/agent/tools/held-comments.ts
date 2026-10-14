import type { WorkflowRuntime } from "../../workflow/types";
import { PROMPT_TASK } from "./task";

/** How the agent treats the comments held on a page artifact. Kept next to the check that carries them. */
export const HELD_COMMENT_RULES = `## Held Page Comments
* **Expect** a person's comment on a page artifact to be held. The system sends the held comments of a page to its author when a comment there mentions you, when a person tells you they finished reviewing or asks for a revision, and with every \`${PROMPT_TASK}\` to that author.
* **Read** \`held_comments\` on the job line before you say where page comments are. A count above zero means the author has not received them.
* **Call** \`${PROMPT_TASK}\` on the page's author when a person asks for the held comments to go to it and an agent note does not say they were sent. Say in the text what the person asked for. The comments go with it.`;

/** True when the workflow has a page artifact, where comments can be held. */
export function hasPageArtifact(workflow: WorkflowRuntime): boolean {
  return workflow.store.artifacts().some(({ ref }) => ref.kind === "page");
}
