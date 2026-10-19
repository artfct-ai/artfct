import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { destinationFor } from "../notify/destination";
import type { PostOptions } from "../notify/notifier";
import { recipientsOf, type Recipients } from "../notify/recipients";
import { isWorkflowFinished, workflowName } from "./store/state";
import type { TaskEvent } from "./task/events";
import type { WorkflowRuntime } from "./types";

/**
 * Post to the recipients, by default the workflow's audience. A chat thread leaves its working
 * status for the workflow's name, closed once the workflow finished.
 */
export async function postToRecipients(
  workflow: WorkflowRuntime,
  event: TaskEvent,
  to: Recipients = { answering: [] },
  options: PostOptions = {},
): Promise<void> {
  const targets = recipientsOf(workflow.state, event, to);
  const finished = isWorkflowFinished(workflow.state.status);
  const title = workflowName(workflow.state);
  const destination = destinationFor(event);
  for (const target of targets) {
    if (destination === "channel") {
      await workflow.notifier.post(target, event, { finished, title, ...options });
    } else {
      await workflow.notifier.quiet(target, event, destination);
    }
  }
}

/** Take every chat thread among the reply targets, or only one, out of its working status. */
export async function releaseChatThreads(
  workflow: WorkflowRuntime,
  only?: ReplyTarget,
): Promise<void> {
  const targets = only ? [only] : workflow.state.reply_targets;
  const finished = isWorkflowFinished(workflow.state.status);
  const title = workflowName(workflow.state);
  for (const target of targets) {
    if (target.source === "chat") await workflow.notifier.release(target, finished, title);
  }
}

/** Show every chat thread among the reply targets what the agent is doing now. */
export async function showWorking(workflow: WorkflowRuntime, text: string): Promise<void> {
  for (const target of workflow.state.reply_targets) {
    if (target.source === "chat") await workflow.notifier.working(target, text);
  }
}
