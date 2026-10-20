import { z } from "zod";
import { classifyPrompt, isStatus } from "../../classify";
import { extractLinks } from "../../links";
import { addressesSomeoneElse, readableMentions, tagsThisApp } from "./mentions";
import type { ChatInbound, ChatInboundContext, ChatLookup } from "../types";

const mentionEventSchema = z.object({
  type: z.literal("app_mention"),
  user: z.string(),
  text: z.string(),
  channel: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  bot_id: z.string().optional(),
});

const messageEventSchema = z.object({
  type: z.literal("message"),
  user: z.string().optional(),
  text: z.string().optional(),
  channel: z.string(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
});

const reactionEventSchema = z.object({
  type: z.literal("reaction_added"),
  user: z.string(),
  reaction: z.string(),
  item: z.object({ type: z.string(), channel: z.string(), ts: z.string() }),
});

const memberJoinedEventSchema = z.object({
  type: z.literal("member_joined_channel"),
  user: z.string(),
  channel: z.string(),
});

const slackEventSchema = z.discriminatedUnion("type", [
  mentionEventSchema,
  messageEventSchema,
  reactionEventSchema,
  memberJoinedEventSchema,
]);

const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string(),
  event: slackEventSchema,
  authorizations: z.array(z.object({ user_id: z.string() })).optional(),
  /** True for a Slack Connect channel, which another organization shares. */
  is_ext_shared_channel: z.boolean().optional(),
});

type MentionEvent = z.infer<typeof mentionEventSchema>;

type MessageEvent = z.infer<typeof messageEventSchema>;

type ReactionEvent = z.infer<typeof reactionEventSchema>;

/** Slack events the mapper handles. */
export type SlackEvent = z.infer<typeof slackEventSchema>;

/** The `event_callback` envelope from the Slack Events API. */
export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;

/** The ignore for a payload that is not a callback of an event the mapper handles. */
const UNHANDLED_EVENT: ChatInbound = { ignore: "unhandled slack event" };

type SlackContext = ChatInboundContext & { callback: SlackEventCallback };

/**
 * Map a Slack event callback. Mentions start or continue. The one reaction is a short reply.
 * Every event from a Slack Connect channel is ignored, because the other organization controls
 * the profiles of its people. A payload of another shape is ignored.
 */
export async function slackInbound(
  payload: unknown,
  context: ChatInboundContext,
): Promise<ChatInbound> {
  const parsed = slackEventCallbackSchema.safeParse(payload);
  if (!parsed.success) return UNHANDLED_EVENT;
  const callback = parsed.data;
  if (callback.is_ext_shared_channel) return { ignore: "Slack Connect channel" };
  const eventContext: SlackContext = { ...context, callback };
  const event = callback.event;
  switch (event.type) {
    case "app_mention":
      return mentionEvent(event, eventContext);
    case "message":
      return threadReplyEvent(event, eventContext);
    case "reaction_added":
      return reactionEvent(event, eventContext);
    case "member_joined_channel":
      return { ignore: "channel join" };
    default:
      return unhandled(event);
  }
}

const SENDER_UNAUTHORIZED: ChatInbound = { ignore: "sender is not authorized" };

/**
 * A mention starts a workflow, or joins the running one its thread is bound to. A status
 * question inside a thread only asks. A bot's mention is dropped.
 */
async function mentionEvent(event: MentionEvent, context: SlackContext): Promise<ChatInbound> {
  if (event.bot_id) return { ignore: "bot mention" };
  const actor = await resolveActor(context, event.user);
  if (!actor) return SENDER_UNAUTHORIZED;
  const threadTs = event.thread_ts ?? event.ts;
  const text = readableMentions(event.text, botUserId(context.callback));
  const kind = event.thread_ts && isStatus(text) ? "status" : "start";
  return {
    event: {
      id: `slack:${context.callback.event_id}`,
      kind,
      actor,
      bindings: [{ source: "chat_thread", external_id: `${event.channel}:${threadTs}` }],
      links: extractLinks(unwrapSlackLinks(text)),
      text: unwrapSlackLinks(text),
      title: text.split("\n")[0]?.slice(0, 120),
      reply_to: { source: "chat", channel: event.channel, thread: threadTs },
      acknowledge: { message: event.ts, user: event.user },
    },
  };
}

/**
 * Human replies inside a bound thread. Bot, system, and mention messages are dropped, and so is
 * a reply that opens with a tag of somebody else.
 */
async function threadReplyEvent(event: MessageEvent, context: SlackContext): Promise<ChatInbound> {
  const ownUserId = botUserId(context.callback);
  if (!event.thread_ts || event.subtype || event.bot_id) {
    return { ignore: "not a human thread reply" };
  }
  if (!event.user || event.user === ownUserId) return { ignore: "not a human thread reply" };
  if (tagsThisApp(event.text ?? "", ownUserId)) {
    return { ignore: "mention, delivered as app_mention" };
  }
  if (addressesSomeoneElse(event.text ?? "", ownUserId)) {
    return { ignore: "addressed to somebody else" };
  }
  const text = unwrapSlackLinks(readableMentions(event.text ?? "", ownUserId));
  if (!text) return { ignore: "empty" };
  const actor = await resolveActor(context, event.user);
  if (!actor) return SENDER_UNAUTHORIZED;
  return {
    event: {
      id: `slack:${context.callback.event_id}`,
      kind: classifyPrompt(text),
      actor,
      bindings: [{ source: "chat_thread", external_id: `${event.channel}:${event.thread_ts}` }],
      links: extractLinks(text),
      text,
      reply_to: { source: "chat", channel: event.channel, thread: event.thread_ts },
      acknowledge: { message: event.ts, user: event.user },
    },
  };
}

/** The configured reaction on any message in a thread is a one-word reply to the workflow bound to it. */
async function reactionEvent(event: ReactionEvent, context: SlackContext): Promise<ChatInbound> {
  if (event.reaction !== context.reaction || event.item.type !== "message") {
    return { ignore: `reaction ${event.reaction}` };
  }
  const actor = await resolveActor(context, event.user);
  if (!actor) return SENDER_UNAUTHORIZED;
  const channel = event.item.channel;
  const threadTs = await threadRoot(context.chat, channel, event.item.ts);
  return {
    event: {
      id: `slack:${context.callback.event_id}`,
      kind: "prompt",
      actor,
      bindings: [{ source: "chat_thread", external_id: `${channel}:${threadTs}` }],
      links: [],
      text: `reacted with :${event.reaction}:`,
      reply_to: { source: "chat", channel, thread: threadTs },
    },
  };
}

function unhandled(_event: never): ChatInbound {
  return UNHANDLED_EVENT;
}

/** The thread root of a message, which is what a binding is keyed on. */
async function threadRoot(chat: ChatLookup, channel: string, ts: string): Promise<string> {
  if (!chat) return ts;
  return chat.threadRootTs(channel, ts).catch(() => ts);
}

/** The sender's name, email and team come from the user lookup, which needs a bot token. */
async function resolveActor(context: SlackContext, userId: string) {
  const user = context.chat ? await context.chat.user(userId).catch(() => null) : null;
  if (!user) return context.resolveActor({ id: userId, email: null, member_of_team: null });
  return context.resolveActor({ ...user, email: user.email?.toLowerCase() ?? null });
}

/**
 * The channel this app itself was just added to, or null for any other payload. A Slack Connect
 * channel names no channel, so the app does not greet where it will not answer.
 */
export function appJoinedChannel(payload: unknown): string | null {
  const parsed = slackEventCallbackSchema.safeParse(payload);
  if (!parsed.success) return null;
  const callback = parsed.data;
  if (callback.is_ext_shared_channel) return null;
  const event = callback.event;
  if (event.type !== "member_joined_channel") return null;
  if (event.user !== botUserId(callback)) return null;
  return event.channel;
}

/** This app's own Slack user id, which every event callback names. */
function botUserId(callback: SlackEventCallback): string | undefined {
  return callback.authorizations?.[0]?.user_id;
}

/** Slack wraps links as <url|label>. */
export function unwrapSlackLinks(text: string): string {
  return text.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1");
}
