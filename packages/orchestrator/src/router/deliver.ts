import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { BaseMovedDetail, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Binding } from "@artfct-ai/contracts/sources";
import type { Delivery, RpcAck, WorkflowStatus } from "@artfct-ai/contracts/types";
import { chat, tracker } from "../clients";
import { registeredConfig } from "../config/register-config";
import {
  abandonWorkflowCreate,
  claimBinding,
  claimBindingAndRecordPredecessor,
  findBinding,
  takeOverWorkflowCreate,
  workflowsWithPullsInRepo,
  type WonBinding,
} from "../db/bindings";
import { createDb, type Database } from "../db/client";
import { createWorkflow, findWorkflow } from "../db/workflows";
import type { Env } from "../env";
import { newWorkflowId } from "../ids";
import { isWorkflowFinished } from "../workflow/store/state";
import { NOTHING_TO_JOIN, postStartingThought, postTrackerAck } from "./tracker-ack";
import { deliverWithChatAck } from "./chat-ack";

/** A binding of an event and the workflow it pointed at when the route read it. */
type BoundBinding = { binding: Binding; workflowId: string | null };

/** The first binding of an event whose workflow ended, by its place in the event's bindings. */
type EndedBinding = { index: number; workflowId: string; status: WorkflowStatus };

/** What a delivery read so far: every binding, and the first one whose workflow ended. */
type RouteRead = { bound: BoundBinding[]; replaced: EndedBinding | null };

/** Where an event goes: to the running workflow at one of its bindings, to a new one, or nowhere. */
type Route =
  | ({ kind: "join"; index: number; binding: Binding; workflowId: string } & RouteRead)
  | ({ kind: "create" } & RouteRead)
  | { kind: "drop"; reason: string };

/**
 * Route an event to its workflow, or start the next one, and acknowledge it on its surface. A
 * person's message in a tracker session that no workflow takes is told so.
 */
export async function deliver(
  env: Env,
  event: InboundEvent,
  ackTracker?: Tracker | null,
): Promise<Delivery> {
  const db = createDb(env.DB);
  if (event.pull?.action === "base_moved") return fanOutBaseMoved(env, db, event, event.pull);
  const route = await routeOf(db, event);
  const sessionId = startingSessionOf(event, route);
  const messageSessionId = messageSessionOf(event);
  if (!sessionId && route.kind === "drop" && messageSessionId) {
    const acking = await ackingTracker(env, ackTracker);
    await postTrackerAck(acking, messageSessionId, { type: "error", body: NOTHING_TO_JOIN });
    return { dropped: route.reason };
  }
  if (!sessionId) {
    const chatClient = chat(env, registeredConfig().config.adapters.chat.provider);
    return deliverWithChatAck(chatClient, event, () => follow(env, db, event, route));
  }
  const acking = await ackingTracker(env, ackTracker);
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

/** The tracker that acknowledges on sessions: the one the caller passed, else the installed one. */
function ackingTracker(env: Env, ackTracker: Tracker | null | undefined): Promise<Tracker | null> {
  return ackTracker === undefined ? tracker(env) : Promise.resolve(ackTracker);
}

/** The tracker session of a person's prompt or status question, or null. */
function messageSessionOf(event: InboundEvent): string | null {
  if (!event.actor || (event.kind !== "prompt" && event.kind !== "status")) return null;
  return event.reply_to?.source === "tracker" ? event.reply_to.session_id : null;
}

/** Read every binding of the event, then decide where it goes. */
async function routeOf(db: Database, event: InboundEvent): Promise<Route> {
  const bound: BoundBinding[] = [];
  for (const binding of event.bindings) {
    bound.push({ binding, workflowId: await findBinding(db, binding) });
  }
  return routeFrom(db, event, { bound, replaced: null }, 0);
}

/**
 * Decide where the event goes from the binding at `from` on. The first bound workflow that has
 * not ended is joined. Else a start, or a person's message on a binding whose workflow ended,
 * starts the next workflow. Every other event is dropped.
 */
async function routeFrom(
  db: Database,
  event: InboundEvent,
  read: RouteRead,
  from: number,
): Promise<Route> {
  let { replaced } = read;
  for (const [index, { binding, workflowId }] of read.bound.entries()) {
    if (index < from || !workflowId) continue;
    const ended = await endedStatus(db, workflowId);
    if (!ended) return { kind: "join", index, binding, workflowId, ...read, replaced };
    replaced ??= { index, workflowId, status: ended };
  }
  const personWrote = event.kind === "prompt" && event.actor !== null;
  if (event.kind !== "start" && !(replaced && personWrote)) {
    const reason = replaced
      ? `workflow ${replaced.workflowId} is ${replaced.status}`
      : `no workflow bound for ${event.kind}`;
    return { kind: "drop", reason };
  }
  if (!event.actor) return { kind: "drop", reason: "no actor to start a workflow for" };
  return { kind: "create", bound: read.bound, replaced };
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
      return joinWorkflow(env, db, event, route);
    case "create":
      return startNextWorkflow(env, db, event, route);
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled route ${String(unreachable)}`);
    }
  }
}

/**
 * Claim the binding whose workflow ended, else the first binding, then create the next workflow.
 * The claim of a binding whose workflow ended records that workflow as the predecessor. Each other
 * binding moves to the next workflow only if it still points where the route read it.
 */
async function startNextWorkflow(
  env: Env,
  db: Database,
  event: InboundEvent,
  route: Extract<Route, { kind: "create" }>,
): Promise<Delivery> {
  const workflowId = newWorkflowId();
  const claimedIndex = route.replaced?.index ?? 0;
  const claimed = route.bound[claimedIndex];
  const predecessorId = route.replaced?.workflowId ?? null;
  const won: WonBinding[] = [];
  if (claimed) {
    const claim = { previous: claimed.workflowId, workflowId };
    const claimWon = predecessorId
      ? await claimBindingAndRecordPredecessor(db, claimed.binding, { ...claim, predecessorId })
      : await claimBinding(db, claimed.binding, claim);
    if (!claimWon) return follow(env, db, event, await routeOf(db, event));
    won.push({ binding: claimed.binding, previous: claimed.workflowId });
  }
  await createWorkflow(db, workflowId);
  for (const [index, bound] of route.bound.entries()) {
    if (index === claimedIndex) continue;
    const previous = bound.workflowId;
    if (await claimBinding(db, bound.binding, { previous, workflowId })) {
      won.push({ binding: bound.binding, previous });
    }
  }
  try {
    const result = await env.Workflow.getByName(workflowId).create(
      workflowId,
      event,
      predecessorId,
    );
    return { workflow_id: workflowId, created: true, result };
  } catch (error) {
    await abandonWorkflowCreate(db, workflowId, won);
    throw error;
  }
}

/**
 * Hand the event to the running workflow. A workflow not created yet refuses it. A person's start
 * or message then takes its create over, and every other event is dropped. A workflow that ended
 * refuses a person's message, and the route goes on from the next binding. A start the workflow
 * took points its unbound bindings, and those whose workflow ended, at it.
 */
async function joinWorkflow(
  env: Env,
  db: Database,
  event: InboundEvent,
  route: Extract<Route, { kind: "join" }>,
): Promise<Delivery> {
  const { workflowId } = route;
  const answer = await env.Workflow.getByName(workflowId).handle(event);
  if ("refused" in answer) {
    switch (answer.refused) {
      case "not_created":
        return isPersonsStartOrMessage(event)
          ? takeOverCreate(env, db, event, route)
          : { dropped: `workflow ${workflowId} is not created yet` };
      case "ended": {
        const ended = { index: route.index, workflowId, status: answer.status };
        const read = { bound: route.bound, replaced: route.replaced ?? ended };
        return follow(env, db, event, await routeFrom(db, event, read, route.index + 1));
      }
      default: {
        const unreachable: never = answer;
        throw new Error(`unhandled refusal ${String(unreachable)}`);
      }
    }
  }
  const joined = event.kind === "start";
  if (joined) {
    for (const [index, { binding, workflowId: previous }] of route.bound.entries()) {
      const endedOrUnbound = index < route.index || previous === null;
      if (endedOrUnbound) await claimBinding(db, binding, { previous, workflowId });
    }
  }
  return { workflow_id: workflowId, created: false, joined, result: answer };
}

/** A start or a message that a person wrote. */
function isPersonsStartOrMessage(event: InboundEvent): boolean {
  return event.actor !== null && (event.kind === "start" || event.kind === "prompt");
}

/**
 * Create a workflow whose create has not returned with a person's event, such as one whose router
 * invocation ended mid-create. The row marks the takeover first, so an abandon of the first create
 * keeps the bindings. The create names the predecessor the first create recorded. A takeover that
 * a moved binding or an abandon refuses reads the route again.
 */
async function takeOverCreate(
  env: Env,
  db: Database,
  event: InboundEvent,
  route: Extract<Route, { kind: "join" }>,
): Promise<Delivery> {
  const { binding, workflowId } = route;
  const taken = await takeOverWorkflowCreate(db, binding, workflowId);
  if (!taken) return follow(env, db, event, await routeOf(db, event));
  const result = await env.Workflow.getByName(workflowId).create(
    workflowId,
    event,
    taken.predecessorId,
  );
  return { workflow_id: workflowId, created: true, result };
}

/** The status a bound workflow ended with, or null while it runs. */
async function endedStatus(db: Database, workflowId: string): Promise<WorkflowStatus | null> {
  const row = await findWorkflow(db, workflowId);
  return row && isWorkflowFinished(row.status) ? row.status : null;
}

/**
 * A push to the base branch goes to every workflow with a pull request bound in the repo. A
 * failed delivery to one workflow is logged, and the rest still get the event.
 */
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
    try {
      const answer = await env.Workflow.getByName(workflowId).handle(perWorkflow);
      if (!("refused" in answer)) results.push(answer);
    } catch (error) {
      console.warn(`base move delivery to ${workflowId} failed: ${String(error)}`);
    }
  }
  return { fanned_out: workflowIds.length, results };
}
