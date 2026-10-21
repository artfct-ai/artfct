import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RpcAck } from "@artfct-ai/contracts/types";
import { eventMessage } from "../../agent/transcript/envelope";
import { pullDetailOf } from "../../artifact/pull";
import type { PostOptions } from "../../notify/notifier";
import type { Recipients } from "../../notify/recipients";
import { applyEvent, stopSessionAuthor, verbalCommandToRun } from "./apply";
import { postReceipt } from "../feed/feed";
import { armIdle, changeWorkflowStatus } from "../lifecycle";
import { firstLine, type ChatMessageRef } from "../store/state";
import { conversationStatusText } from "../status";
import { jobForEvent } from "./lookup";
import type { TrackerSession } from "./job-session";
import type { Applied, EventRefusal, WorkflowRuntime } from "../types";

const ACK: RpcAck = { ok: true };
const DUPLICATE: RpcAck = { ok: true, duplicate: true };

/**
 * The tracker session of a person's prompt or status question to a running workflow, which gets a
 * receipt. Null for any other event. The router already acknowledges a start. A verbal command
 * other than instruct that runs at once answers the person itself.
 */
function instructedSessionOf(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): TrackerSession | null {
  if (event.actor === null || (event.kind !== "prompt" && event.kind !== "status")) return null;
  if (event.reply_to?.source !== "tracker") return null;
  const command = verbalCommandToRun(workflow, event);
  return command && command.control !== "instruct" ? null : event.reply_to;
}

/** True when a person wrote to the workflow: a message in its chat thread or tracker session. */
function isMessage(event: InboundEvent): boolean {
  return event.actor !== null && (event.kind === "prompt" || event.kind === "start");
}

/**
 * Why the conversation refuses an event the router hands it, or null when it takes it. It refuses
 * every event before it opens, and a person's message once its workflow's end started.
 */
export function eventRefusalOf(
  workflow: WorkflowRuntime,
  event: InboundEvent,
): EventRefusal | null {
  if (!workflow.store.conversation()) return { refused: "not_created" };
  if (!workflow.store.workflowFinished() || !isMessage(event)) return null;
  return { refused: "ended", status: workflow.store.workflowStatus() };
}

/** The first event of a conversation and the ended workflow it follows, if any. */
export type ConversationStart = {
  conversationId: string;
  event: InboundEvent;
  endedWorkflowId: string | null;
};

/**
 * Open the conversation from its first event and hand the event to the agent. It does not create
 * a workflow: only a plan that names a workflow definition does.
 */
export async function openConversation(
  workflow: WorkflowRuntime,
  { conversationId, event, endedWorkflowId }: ConversationStart,
): Promise<RpcAck> {
  if (workflow.store.conversation()) return handleEvent(workflow, event);
  if (!workflow.store.markEventSeen(event.id)) return DUPLICATE;
  const origin = event.reply_to ?? null;
  workflow.store.openConversation({
    conversation_id: conversationId,
    origin,
    request_title: event.title || firstLine(event.text),
    request_text: event.text,
    request_links: event.links,
  });
  workflow.log(null, `opened from ${event.kind}`);
  await acknowledge(workflow, event);
  const notes = endedWorkflowId ? [earlierMessagesNote(endedWorkflowId, origin)] : [];
  await workflow.tellAgent(
    eventMessage(event, { first: true, job: null, artifact: null, notes }),
    "message",
    { body: event.text.trim(), chat_message: chatMessageOf(event) },
  );
  return { ok: true, workflow_id: conversationId };
}

/** Tell the first turn where the ended workflow's messages are. */
function earlierMessagesNote(endedWorkflowId: string, origin: ReplyTarget | null): string {
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

/**
 * True for feedback on a running workflow. It is marked seen when its routing lands, so a
 * delivery that a restart cut off routes when the host delivers it again.
 */
function routesBeforeItIsSeen(workflow: WorkflowRuntime, event: InboundEvent): boolean {
  return event.kind === "feedback" && !workflow.store.workflowFinished();
}

/**
 * Every later event: dedupe, record what code must record, then tell the agent. Any other event
 * is marked seen in the same synchronous block as the first write of its effect, so a delivery
 * that a restart cuts off while it wakes the workflow lands when the host delivers it again.
 */
export async function handleEvent(workflow: WorkflowRuntime, event: InboundEvent): Promise<RpcAck> {
  if (workflow.store.eventSeen(event.id)) return DUPLICATE;
  if (event.reply_to) workflow.store.addReplyTarget(event.reply_to);
  const job = jobForEvent(workflow, event);
  const controlSuffix = event.control ? `:${event.control}` : "";
  const task = job ? workflow.store.authorOrResearcherTaskOf(job.job_id) : null;
  workflow.log(task?.task_id ?? null, `event ${event.kind}${controlSuffix}`);

  if (!workflow.store.workflowFinished()) {
    if (isMessage(event)) await wakeWorkflow(workflow);
    await acknowledge(workflow, event);
    const instructed = instructedSessionOf(workflow, event);
    if (instructed) await postReceipt(workflow, instructed);
  }
  if (!routesBeforeItIsSeen(workflow, event) && !workflow.store.markEventSeen(event.id)) {
    return DUPLICATE;
  }
  if (workflow.store.workflowFinished()) {
    await replyFinished(workflow, event);
    return ACK;
  }
  const postedBefore = workflow.store.postedCount();
  const applied = await applyEvent(workflow, event);
  workflow.store.markEventSeen(event.id);
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
    event.actor
      ? { body: told.text.trim(), reply_to: event.reply_to, chat_message: chatMessageOf(event) }
      : undefined,
  );
}

/** The chat message a person wrote, when the event is one the chat thread acknowledges. */
function chatMessageOf(event: InboundEvent): ChatMessageRef | undefined {
  if (!event.actor || !event.acknowledge || event.reply_to?.source !== "chat") return undefined;
  return { channel: event.reply_to.channel, message: event.acknowledge.message };
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
  const title = workflow.store.workflowName();
  await workflow.notifier.acknowledge(event.reply_to, event.acknowledge, title);
}

/** A message wakes a sleeping workflow and starts its idle clock over. A conversation without one has no idle clock. */
async function wakeWorkflow(workflow: WorkflowRuntime): Promise<void> {
  if (!workflow.store.activeWorkflow()) return;
  await armIdle(workflow);
  if (workflow.store.activeWorkflow()?.status === "waiting_input")
    await changeWorkflowStatus(workflow, "running");
}

/**
 * Answer a person who writes to a finished workflow, which stays finished. A stop still ends the
 * author's session feed.
 */
async function replyFinished(workflow: WorkflowRuntime, event: InboundEvent): Promise<void> {
  const status = workflow.store.workflowStatus();
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
async function postStatus(
  workflow: WorkflowRuntime,
  to?: Recipients,
  options?: PostOptions,
): Promise<void> {
  await workflow.post({ type: "status", text: conversationStatusText(workflow) }, to, options);
}
