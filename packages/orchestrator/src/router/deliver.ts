import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { BaseMovedDetail, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Delivery, RpcAck } from "@artfct-ai/contracts/types";
import { chat, tracker } from "../clients";
import { registeredConfig } from "../config/register-config";
import { conversationsWithPullsInRepo, findBoundConversation } from "../db/bindings";
import { createDb, type Database } from "../db/client";
import { conversationIdOf, conversationRecorded, recordConversation } from "../db/conversations";
import { watcherConversations } from "../db/watches";
import type { Env } from "../env";
import { NOTHING_TO_JOIN, postStartingThought, postTrackerAck } from "./tracker-ack";
import { deliverWithChatAck } from "./chat-ack";

/** Where an event goes: to one conversation, or nowhere. */
type Route = { kind: "deliver"; conversationId: string } | { kind: "drop"; reason: string };

/**
 * Route an event to its conversation and acknowledge it on its surface. A start in a tracker
 * session gets the starting thought. A person's message in a tracker session that the router drops
 * is told so.
 */
export async function deliver(
  env: Env,
  event: InboundEvent,
  ackTracker?: Tracker | null,
): Promise<Delivery> {
  const db = createDb(env.DB);
  if (event.pull?.action === "base_moved") return fanOutBaseMoved(env, db, event, event.pull);
  const startingSessionId = startingSessionOf(event);
  if (startingSessionId) {
    await postStartingThought(await ackingTracker(env, ackTracker), startingSessionId);
    return follow(env, event, await routeOf(db, event));
  }
  const route = await routeOf(db, event);
  const messageSessionId = messageSessionOf(event);
  if (route.kind === "drop" && messageSessionId) {
    const acking = await ackingTracker(env, ackTracker);
    await postTrackerAck(acking, messageSessionId, { type: "error", body: NOTHING_TO_JOIN });
    return { dropped: route.reason };
  }
  const watchers = await watchersOf(db, event);
  if (watchers.length) return fanOutToWatchers(env, event, route, watchers);
  const chatClient = chat(env, registeredConfig().config.adapters.chat.provider);
  return deliverWithChatAck(chatClient, event, () => follow(env, event, route));
}

/** The conversations that watch the pull request the event is about. None for any other event. */
async function watchersOf(db: Database, event: InboundEvent): Promise<string[]> {
  if (event.kind === "start") return [];
  const pull = event.bindings.find((binding) => binding.source === "code_pull");
  return pull ? watcherConversations(db, pull) : [];
}

/**
 * An event on a watched pull request goes to its routed conversation, then to every watcher's
 * conversation, each once. A failed delivery to one conversation is logged, and the rest still get
 * it. It returns only after every delivery returned, so the event's firings queue after the
 * watchers heard it.
 */
async function fanOutToWatchers(
  env: Env,
  event: InboundEvent,
  route: Route,
  watchers: string[],
): Promise<Delivery> {
  const routed = route.kind === "deliver" ? [route.conversationId] : [];
  const conversationIds = [...new Set([...routed, ...watchers])];
  const results: RpcAck[] = [];
  for (const conversationId of conversationIds) {
    try {
      const stub = env.Conversation.getByName(conversationId);
      results.push(await stub.handle(conversationId, event));
    } catch (error) {
      console.warn(`watched pull request delivery to ${conversationId} failed: ${String(error)}`);
    }
  }
  return { fanned_out: conversationIds.length, results };
}

/** The tracker session a start was said in, or null. */
function startingSessionOf(event: InboundEvent): string | null {
  if (event.kind !== "start" || event.reply_to?.source !== "tracker") return null;
  return event.reply_to.session_id;
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

/**
 * The conversation a binding of the event leads to through a workflow that has not finished. Else
 * its place's conversation, which a start records and any other event needs recorded. Else none.
 */
async function routeOf(db: Database, event: InboundEvent): Promise<Route> {
  const bound = await findBoundConversation(db, event.bindings);
  if (bound) return { kind: "deliver", conversationId: bound };
  const { place } = event;
  if (!place) return { kind: "drop", reason: `no conversation for ${event.kind}` };
  if (event.kind === "start") await recordConversation(db, place);
  else if (!(await conversationRecorded(db, place))) {
    return { kind: "drop", reason: `no conversation in its ${place.source}` };
  }
  return { kind: "deliver", conversationId: await conversationIdOf(place) };
}

/** Carry the event along its route. */
async function follow(env: Env, event: InboundEvent, route: Route): Promise<Delivery> {
  switch (route.kind) {
    case "drop":
      return { dropped: route.reason };
    case "deliver": {
      const { conversationId } = route;
      const result = await env.Conversation.getByName(conversationId).handle(conversationId, event);
      return { conversation_id: conversationId, result };
    }
    default: {
      const unreachable: never = route;
      throw new Error(`unhandled route ${String(unreachable)}`);
    }
  }
}

/**
 * A push to the base branch goes to every conversation whose running workflow has a pull request
 * bound in the repo. A failed delivery to one conversation is logged, and the rest still get it.
 */
async function fanOutBaseMoved(
  env: Env,
  db: Database,
  event: InboundEvent,
  detail: BaseMovedDetail,
): Promise<Delivery> {
  const conversationIds = await conversationsWithPullsInRepo(db, detail.repo);
  const results: RpcAck[] = [];
  for (const conversationId of conversationIds) {
    const perConversation: InboundEvent = {
      ...event,
      id: `${event.id}:${conversationId}`,
      pull: detail,
    };
    try {
      const stub = env.Conversation.getByName(conversationId);
      results.push(await stub.handle(conversationId, perConversation));
    } catch (error) {
      console.warn(`base move delivery to ${conversationId} failed: ${String(error)}`);
    }
  }
  return { fanned_out: conversationIds.length, results };
}
