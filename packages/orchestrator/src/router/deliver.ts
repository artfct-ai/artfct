import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { BaseMovedDetail, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Delivery, RpcAck, WorkflowStatus } from "@artfct-ai/contracts/types";
import { chat, tracker } from "../clients";
import { registeredConfig } from "../config/register-config";
import {
  bindWorkflow,
  deleteBindings,
  resolveBinding,
  workflowsWithPullsInRepo,
} from "../db/bindings";
import { createDb, type Database } from "../db/client";
import { createWorkflow, findWorkflow, setWorkflowStatus } from "../db/workflows";
import type { Env } from "../env";
import { newWorkflowId } from "../ids";
import { isWorkflowFinished } from "../workflow/store/state";
import {
  NOTHING_TO_JOIN,
  postStartingThought,
  postTrackerAck,
  trackerSessionId,
} from "./tracker-ack";
import { deliverWithChatAck } from "./chat-ack";

/**
 * Route an event to its running workflow. A `start` event that binds to nothing, or only to an
 * ended workflow, creates one. A tracker agent session gets the starting thought before it is
 * routed. A chat message that waits longer than a few seconds gets the eyes reaction until its
 * workflow takes it. `ackTracker` is a seam for tests and defaults to the tracker over the install.
 */
export async function deliver(
  env: Env,
  event: InboundEvent,
  ackTracker?: Tracker | null,
): Promise<Delivery> {
  const sessionId = trackerSessionId(event);
  if (!sessionId) {
    const chatClient = chat(env, registeredConfig().config.adapters.chat.provider);
    return deliverWithChatAck(chatClient, event, () => route(env, event));
  }
  const acking = ackTracker === undefined ? await tracker(env) : ackTracker;
  await postStartingThought(acking, sessionId);
  const delivery = await route(env, event);
  if (!event.actor && "dropped" in delivery) {
    await postTrackerAck(acking, sessionId, { type: "error", body: NOTHING_TO_JOIN });
  }
  return delivery;
}

async function route(env: Env, event: InboundEvent): Promise<Delivery> {
  const db = createDb(env.DB);
  if (event.pull?.action === "base_moved") return fanOutBaseMoved(env, db, event, event.pull);

  const bound = await resolveBinding(db, event.bindings);
  if (bound) {
    const ended = await endedStatus(db, bound);
    if (!ended) return joinOrHandle(env, db, bound, event);
    if (event.kind !== "start") return { dropped: `workflow ${bound} is ${ended}` };
  } else if (event.kind !== "start") {
    return { dropped: `no workflow bound for ${event.kind}` };
  }
  if (!event.actor) return { dropped: "no actor to start a workflow for" };

  const workflowId = newWorkflowId();
  await createWorkflow(db, workflowId);
  for (const binding of event.bindings) await bindWorkflow(db, binding, workflowId);
  try {
    const result = await env.Workflow.getByName(workflowId).create(workflowId, event);
    return { workflow_id: workflowId, created: true, result };
  } catch (error) {
    await abandonWorkflow(db, workflowId, event);
    throw error;
  }
}

/**
 * Undo a workflow whose Durable Object never started: free its bindings, so the next start
 * creates another, and record it as failed.
 */
async function abandonWorkflow(
  db: Database,
  workflowId: string,
  event: InboundEvent,
): Promise<void> {
  const sources = event.bindings.map((binding) => binding.source);
  await deleteBindings(db, workflowId, sources);
  await setWorkflowStatus(db, workflowId, "failed");
}

/**
 * A start event on a running workflow joins it: every binding the event carries now points
 * at that workflow, and the message is a prompt.
 */
async function joinOrHandle(
  env: Env,
  db: Database,
  workflowId: string,
  event: InboundEvent,
): Promise<Delivery> {
  const joined = event.kind === "start";
  if (joined) {
    for (const binding of event.bindings) await bindWorkflow(db, binding, workflowId);
  }
  const result = await env.Workflow.getByName(workflowId).handle(event);
  return { workflow_id: workflowId, created: false, joined, result };
}

/**
 * The status a bound workflow ended with, from its D1 row. Null while it runs. An ended workflow
 * takes no more events: a start on its bindings begins a new workflow, and the rest are dropped.
 */
async function endedStatus(db: Database, workflowId: string): Promise<WorkflowStatus | null> {
  const row = await findWorkflow(db, workflowId);
  return row && isWorkflowFinished(row.status) ? row.status : null;
}

/** A push to the base branch goes to every workflow with a pull request bound in the repo. */
async function fanOutBaseMoved(
  env: Env,
  db: Database,
  event: InboundEvent,
  detail: BaseMovedDetail,
): Promise<Delivery> {
  const workflowIds = await workflowsWithPullsInRepo(db, detail.repo);
  const results: RpcAck[] = [];
  for (const workflowId of workflowIds) {
    const perWorkflow: InboundEvent = { ...event, id: `${event.id}:${workflowId}`, pull: detail };
    results.push(await env.Workflow.getByName(workflowId).handle(perWorkflow));
  }
  return { fanned_out: workflowIds.length, results };
}
