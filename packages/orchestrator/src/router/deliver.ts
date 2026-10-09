import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { BaseMovedDetail, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { Delivery, RpcAck, WorkflowStatus } from "@artfct-ai/contracts/types";
import { chat, tracker } from "../clients";
import { registeredConfig } from "../config/register-config";
import {
  bindWorkflow,
  claimBinding,
  deleteBindings,
  findBinding,
  workflowsWithPullsInRepo,
} from "../db/bindings";
import { createDb, type Database } from "../db/client";
import { createWorkflow, findWorkflow, setWorkflowStatus } from "../db/workflows";
import type { Env } from "../env";
import { newWorkflowId } from "../ids";
import { isWorkflowFinished } from "../workflow/store/state";
import { NOTHING_TO_JOIN, postStartingThought, postTrackerAck } from "./tracker-ack";
import { deliverWithChatAck } from "./chat-ack";

/** A binding of an event and the workflow it points at. */
type BoundBinding = { binding: Binding; workflowId: string | null };

/** Where an event goes: to a running workflow, to a new one, or nowhere. */
type Route =
  | { kind: "join"; workflowId: string }
  | { kind: "create"; bound: BoundBinding[]; replaced: EndedBinding | null }
  | { kind: "drop"; reason: string };

/** A binding that points at a workflow that ended. */
type EndedBinding = { binding: Binding; workflowId: string; status: WorkflowStatus };

/** Route an event to its workflow, or start the next one, and acknowledge it on its surface. */
export async function deliver(
  env: Env,
  event: InboundEvent,
  ackTracker?: Tracker | null,
): Promise<Delivery> {
  const db = createDb(env.DB);
  if (event.pull?.action === "base_moved") return fanOutBaseMoved(env, db, event, event.pull);
  const route = await routeOf(db, event);
  const sessionId = startingSessionOf(event, route);
  if (!sessionId) {
    const chatClient = chat(env, registeredConfig().config.adapters.chat.provider);
    return deliverWithChatAck(chatClient, event, () => follow(env, db, event, route));
  }
  const acking = ackTracker === undefined ? await tracker(env) : ackTracker;
  await postStartingThought(acking, sessionId);
  const delivery = await follow(env, db, event, route);
  if (!event.actor && "dropped" in delivery) {
    await postTrackerAck(acking, sessionId, { type: "error", body: NOTHING_TO_JOIN });
  }
  return delivery;
}

/** The tracker session that gets the starting thought, or null. */
function startingSessionOf(event: InboundEvent, route: Route): string | null {
  if (event.reply_to?.source !== "tracker") return null;
  return event.kind === "start" || route.kind === "create" ? event.reply_to.session_id : null;
}

/** Decide where the event goes. */
async function routeOf(db: Database, event: InboundEvent): Promise<Route> {
  const bound: BoundBinding[] = [];
  for (const binding of event.bindings) {
    bound.push({ binding, workflowId: await findBinding(db, binding) });
  }
  let replaced: EndedBinding | null = null;
  for (const { binding, workflowId } of bound) {
    if (!workflowId) continue;
    const ended = await endedStatus(db, workflowId);
    if (!ended) return { kind: "join", workflowId };
    replaced ??= { binding, workflowId, status: ended };
  }
  const personWrote = event.kind === "prompt" && event.actor !== null;
  if (event.kind !== "start" && !(replaced && personWrote)) {
    const reason = replaced
      ? `workflow ${replaced.workflowId} is ${replaced.status}`
      : `no workflow bound for ${event.kind}`;
    return { kind: "drop", reason };
  }
  if (!event.actor) return { kind: "drop", reason: "no actor to start a workflow for" };
  return { kind: "create", bound, replaced };
}

/** Carry the event along its route. */
async function follow(
  env: Env,
  db: Database,
  event: InboundEvent,
  route: Route,
): Promise<Delivery> {
  switch (route.kind) {
    case "drop":
      return { dropped: route.reason };
    case "join":
      return joinOrHandle(env, db, route.workflowId, event);
    case "create":
      return startNextWorkflow(env, db, event, route);
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled route ${String(unreachable)}`);
    }
  }
}

/** Claim the event's binding, then create the next workflow and bind it. */
async function startNextWorkflow(
  env: Env,
  db: Database,
  event: InboundEvent,
  route: Extract<Route, { kind: "create" }>,
): Promise<Delivery> {
  const workflowId = newWorkflowId();
  const claimed = route.replaced ?? route.bound[0];
  if (claimed) {
    const previous = claimed.workflowId;
    const won = await claimBinding(db, claimed.binding, { previous, workflowId });
    if (!won) return follow(env, db, event, await routeOf(db, event));
  }
  await createWorkflow(db, workflowId);
  for (const binding of event.bindings) await bindWorkflow(db, binding, workflowId);
  const endedWorkflowId = route.replaced?.workflowId ?? null;
  try {
    const result = await env.Workflow.getByName(workflowId).create(
      workflowId,
      event,
      endedWorkflowId,
    );
    return { workflow_id: workflowId, created: true, result };
  } catch (error) {
    await abandonWorkflow(db, workflowId, route.bound);
    throw error;
  }
}

/** Undo a workflow whose Durable Object never started and point its bindings back. */
async function abandonWorkflow(
  db: Database,
  workflowId: string,
  bound: BoundBinding[],
): Promise<void> {
  const sources = bound.map(({ binding }) => binding.source);
  await deleteBindings(db, workflowId, sources);
  for (const { binding, workflowId: previous } of bound) {
    if (previous) await bindWorkflow(db, binding, previous);
  }
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

/** The status a bound workflow ended with, or null while it runs. */
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
