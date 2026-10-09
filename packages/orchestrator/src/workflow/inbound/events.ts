import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RpcAck } from "@artfct-ai/contracts/types";
import { eventMessage } from "../../agent/transcript/envelope";
import { pullDetailOf } from "../../artifact/pull";
import type { PostOptions } from "../../notify/notifier";
import type { Recipients } from "../../notify/recipients";
import { applyEvent, stopSessionAuthor } from "./apply";
import { armIdle, changeWorkflowStatus } from "../lifecycle";
import { firstLine, isWorkflowFinished, now, workflowName } from "../store/state";
import { statusText, summarize } from "../status";
import { jobForEvent } from "./lookup";
import type { Applied, WorkflowRuntime } from "../types";

const ACK: RpcAck = { ok: true };

/** True when a person wrote to the workflow: a message in its chat thread or tracker session. */
export function isMessage(event: InboundEvent): boolean {
  return event.actor !== null && (event.kind === "prompt" || event.kind === "start");
}

/** The first event of a workflow and the ended workflow it follows, if any. */
export type WorkflowStart = {
  workflowId: string;
  event: InboundEvent;
  endedWorkflowId: string | null;
};

/** Record a workflow's first event and hand it to the agent. */
export async function createWorkflow(
  workflow: WorkflowRuntime,
  { workflowId, event, endedWorkflowId }: WorkflowStart,
): Promise<RpcAck> {
  if (workflow.state.status !== "new") return handleEvent(workflow, event);
  if (!workflow.store.markEventSeen(event)) return { ok: true, duplicate: true };
  const origin = event.reply_to ?? null;
  workflow.patchState({
    workflow_id: workflowId,
    status: "planning",
    starter: event.actor,
    origin,
    reply_targets: origin ? [origin] : [],
    request: { title: event.title || firstLine(event.text), text: event.text, links: event.links },
    created_at: now(),
  });
  workflow.log(null, `created from ${event.kind}`);
  await acknowledge(workflow, event);
  await armIdle(workflow);
  const notes = endedWorkflowId ? [earlierMessagesNote(endedWorkflowId, origin)] : [];
  await workflow.tellAgent(
    eventMessage(event, { first: true, job: null, artifact: null, notes }),
    "message",
  );
  return { ok: true, workflow_id: workflowId };
}

/** Tell the first turn where the ended workflow's messages are. */
export function earlierMessagesNote(endedWorkflowId: string, origin: ReplyTarget | null): string {
  const ended = `This workflow started because workflow ${endedWorkflowId} ended here. Its messages are not in your transcript.`;
  switch (origin?.source) {
    case "chat":
      return `${ended} Read this thread with read_channel and thread_ts=${origin.thread} before you answer.`;
    case "tracker":
      return `${ended} Read the comments of tracker issue ${origin.issue_id} before you answer.`;
    default:
      return `${ended} Read the earlier messages of this conversation before you answer.`;
  }
}

/** Every later event: dedupe, record what code must record, then tell the agent. */
export async function handleEvent(workflow: WorkflowRuntime, event: InboundEvent): Promise<RpcAck> {
  if (!workflow.store.markEventSeen(event)) return { ok: true, duplicate: true };
  addReplyTarget(workflow, event.reply_to);
  const job = jobForEvent(workflow, event);
  const controlSuffix = event.control ? `:${event.control}` : "";
  const task = job ? workflow.store.authorOrResearcherTaskOf(job.job_id) : null;
  workflow.log(task?.task_id ?? null, `event ${event.kind}${controlSuffix}`);

  if (isWorkflowFinished(workflow.state.status)) {
    await replyFinished(workflow, event);
    return ACK;
  }
  if (isMessage(event)) await wakeWorkflow(workflow);
  await acknowledge(workflow, event);
  const postedBefore = workflow.store.postedCount();
  const applied = await applyEvent(workflow, event);
  if (applied !== "handled") await tellAgentAbout(workflow, event, applied);
  const wake = applied === "handled" ? "none" : applied.wake;
  if (wake === "none") await releaseIfSilent(workflow, event, postedBefore);
  return ACK;
}

/** Hand one event to the agent, with the job it is about and what code already did for it. */
async function tellAgentAbout(
  workflow: WorkflowRuntime,
  event: InboundEvent,
  applied: Applied,
): Promise<void> {
  const matched = jobForEvent(workflow, event);
  const artifact = matched ? workflow.store.artifact(matched.job_id) : null;
  const task = matched ? workflow.store.authorOrResearcherTaskOf(matched.job_id) : null;
  const told = pullDetailOf(event)?.reviewer_is_app ? { ...event, text: "" } : event;
  await workflow.tellAgent(
    eventMessage(told, {
      first: false,
      job: matched && task ? { job_id: matched.job_id, task_id: task.task_id } : null,
      artifact: artifact ? { kind: artifact.kind, status: artifact.status } : null,
      notes: applied.notes,
    }),
    applied.wake,
    event.actor ? event.reply_to : undefined,
  );
}

/** No turn will run for this event. Release a chat thread when nothing was posted for it. */
async function releaseIfSilent(
  workflow: WorkflowRuntime,
  event: InboundEvent,
  postedBefore: number,
): Promise<void> {
  if (!event.reply_to || workflow.store.postedCount() !== postedBefore) return;
  await workflow.release(event.reply_to);
}

/** Show the chat thread the message was received by putting it in its working status. */
async function acknowledge(workflow: WorkflowRuntime, event: InboundEvent): Promise<void> {
  if (!event.acknowledge || event.reply_to?.source !== "chat") return;
  const title = workflowName(workflow.state);
  await workflow.notifier.acknowledge(event.reply_to, event.acknowledge, title);
}

/** A message wakes a sleeping workflow and starts the idle clock over. */
async function wakeWorkflow(workflow: WorkflowRuntime): Promise<void> {
  await armIdle(workflow);
  if (workflow.state.status === "waiting_input") await changeWorkflowStatus(workflow, "running");
}

/**
 * Answer a person who writes to a finished workflow, which stays finished. A stop still ends the
 * author's session feed.
 */
async function replyFinished(workflow: WorkflowRuntime, event: InboundEvent): Promise<void> {
  const { status } = workflow.state;
  if (event.kind === "stop") {
    await stopSessionAuthor(workflow, event);
    return;
  }
  if (!event.reply_to || !event.actor) {
    workflow.log(null, `ignored ${event.kind}: the workflow is ${status}`);
    return;
  }
  const options: PostOptions = { keepSession: true };
  const to = { reply_to: event.reply_to };
  if (event.kind === "status") return postStatus(workflow, to, options);
  await workflow.post(
    { type: "info", text: `This workflow is ${status}. Start a new request for more work.` },
    to,
    options,
  );
}

/** Post the workflow status summary to its recipients, by default the workflow's audience. */
export async function postStatus(
  workflow: WorkflowRuntime,
  to?: Recipients,
  options?: PostOptions,
): Promise<void> {
  await workflow.post({ type: "status", text: statusText(summarize(workflow)) }, to, options);
}

function addReplyTarget(workflow: WorkflowRuntime, target?: ReplyTarget): void {
  if (!target) return;
  const key = JSON.stringify(target);
  const known = workflow.state.reply_targets.some((existing) => JSON.stringify(existing) === key);
  if (known) return;
  workflow.patchState({ reply_targets: [...workflow.state.reply_targets, target] });
}
