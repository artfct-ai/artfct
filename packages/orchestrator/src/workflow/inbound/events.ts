import type { InboundEvent, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { RpcAck } from "@artfct-ai/contracts/types";
import { eventMessage } from "../../agent/transcript/envelope";
import { pullDetailOf } from "../../artifact/pull";
import type { PostOptions } from "../../notify/notifier";
import { applyEvent } from "./apply";
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

/** First event of a workflow. Records the request and hands it to the agent. */
export async function createWorkflow(
  workflow: WorkflowRuntime,
  workflowId: string,
  event: InboundEvent,
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
  await workflow.tellAgent(
    eventMessage(event, { first: true, job: null, artifact: null, notes: [] }),
    "message",
  );
  return { ok: true, workflow_id: workflowId };
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
  const postedBefore = workflow.store.postedCount();
  const applied = await applyEvent(workflow, event);
  const wakesAgent = applied !== "handled" && applied.wake !== "none";
  if (wakesAgent) await acknowledge(workflow, event);
  if (applied !== "handled") await tellAgentAbout(workflow, event, applied);
  if (!wakesAgent) await answerIfSilent(workflow, event, postedBefore);
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
  );
}

/**
 * No turn will run for this event. When nothing was posted for it, a chat message gets the eyes
 * reaction and any other reply target is released.
 */
async function answerIfSilent(
  workflow: WorkflowRuntime,
  event: InboundEvent,
  postedBefore: number,
): Promise<void> {
  if (!event.reply_to || workflow.store.postedCount() !== postedBefore) return;
  if (event.reply_to.source === "chat" && event.acknowledge) {
    await workflow.notifier.ackReaction(event.reply_to, event.acknowledge.message);
    return;
  }
  await workflow.release(event.reply_to);
}

/**
 * Show the chat thread that a message which wakes the agent was received. An idle agent starts a
 * turn on it, so the thread enters its working state. A busy agent takes it in the next turn, so
 * the message gets the eyes reaction.
 */
async function acknowledge(workflow: WorkflowRuntime, event: InboundEvent): Promise<void> {
  if (!event.acknowledge || event.reply_to?.source !== "chat") return;
  if (workflow.agentTurnRunning()) {
    await workflow.notifier.ackReaction(event.reply_to, event.acknowledge.message);
    return;
  }
  const title = workflowName(workflow.state);
  await workflow.notifier.acknowledge(event.reply_to, event.acknowledge, title);
}

/** A message wakes a sleeping workflow and starts the idle clock over. */
async function wakeWorkflow(workflow: WorkflowRuntime): Promise<void> {
  await armIdle(workflow);
  if (workflow.state.status === "waiting_input") await changeWorkflowStatus(workflow, "running");
}

/**
 * A finished workflow stays finished. It answers a status question, and any other event with a
 * reply target hears that it is finished. Everything else is logged and dropped.
 */
async function replyFinished(workflow: WorkflowRuntime, event: InboundEvent): Promise<void> {
  const { status } = workflow.state;
  if (!event.reply_to) {
    workflow.log(null, `ignored ${event.kind}: the workflow is ${status}`);
    return;
  }
  const options: PostOptions = { keepSession: true };
  if (event.kind === "status") return postStatus(workflow, event.reply_to, options);
  await workflow.post(
    { type: "info", text: `This workflow is ${status}. Start a new request for more work.` },
    event.reply_to,
    options,
  );
}

/** Post the workflow status summary to one reply target, or to every one. */
export async function postStatus(
  workflow: WorkflowRuntime,
  to?: ReplyTarget,
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
