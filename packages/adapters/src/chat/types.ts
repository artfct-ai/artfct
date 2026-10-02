/**
 * The chat capability: thread replies, reactions, agent session status, user lookup, and
 * reading back through a channel. Consumers program against `Chat`. Slack implements it today.
 * Callers write Markdown. An implementation converts it to the markup its vendor renders.
 */
import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ChatUser } from "@artfct-ai/contracts/types";

/** Resolves a chat user to a person the orchestrator trusts, or to null. */
export type ChatActorResolver = (user: ChatUser) => Promise<Actor | null>;

/** A normalized event ready to deliver, or the reason the callback is ignored. */
export type ChatInbound = { event: InboundEvent } | { ignore: string };

/** The chat lookups a webhook mapper needs. Null when no bot token is configured. */
export type ChatLookup = Pick<Chat, "user" | "threadRootTs"> | null;

/** What a chat event mapper needs besides the callback. */
export type ChatInboundContext = {
  resolveActor: ChatActorResolver;
  chat: ChatLookup;
  /** The one reaction that reaches a workflow, as a short reply. */
  reaction: string;
};

/** Lifecycle status of a chat agent session. `processing` shows the loading state in the thread. */
export type SessionStatus = "processing" | "active" | "closed";

/** Options for `Chat.setSessionStatus`. */
export type SessionOptions = { title?: string; initiatorUserId?: string };

/** One message as a history read returns it. `user` is a user id, a bot id, or null. */
export type ChatMessage = { ts: string; user: string | null; text: string; replyCount: number };

/**
 * One page of a conversation. `hasMore` marks a read the vendor cut short. `cursor` gets the
 * next page: older messages in a channel, later replies in a thread.
 */
export type ChatPage = { messages: ChatMessage[]; hasMore: boolean; cursor: string | null };

/**
 * How much of a conversation to read. `before` takes a channel further back in time.
 * `cursor` continues from a page that was cut short and takes precedence over `before`.
 */
export type HistoryOptions = { limit?: number; before?: string; cursor?: string };

/** What the orchestrator asks of a chat channel. */
export interface Chat {
  /** Reply in a thread. Long text may go out as several replies. Returns the first one. */
  postThreadReply(channel: string, threadTs: string, text: string): Promise<{ ts: string }>;
  /** Post one thread message as is, never split. */
  postThreadMessage(channel: string, threadTs: string, text: string): Promise<{ ts: string }>;
  /** Post one message in the channel itself, outside any thread. */
  postChannelMessage(channel: string, text: string): Promise<void>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  /** Delete one message in a channel or thread. */
  deleteMessage(channel: string, ts: string): Promise<void>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  setSessionStatus(
    channel: string,
    threadTs: string,
    status: SessionStatus,
    options?: SessionOptions,
  ): Promise<void>;
  /** The thread root of a message. A message outside a thread is its own root. */
  threadRootTs(channel: string, ts: string): Promise<string>;
  /** A link to one message that another system can show. */
  permalink(channel: string, ts: string): Promise<string>;
  /** The user as the vendor reports them, or null when the lookup fails. A hidden email is null. */
  user(userId: string): Promise<ChatUser | null>;
  /** The newest channel messages, oldest first. `before` and the cursor both walk into the past. */
  channelHistory(channel: string, options?: HistoryOptions): Promise<ChatPage>;
  /** A thread from the message it hangs off. It pages forward only, so `before` is ignored. */
  threadReplies(channel: string, threadTs: string, options?: HistoryOptions): Promise<ChatPage>;
  /** True when an error says the message no longer exists. */
  isGone(error: unknown): boolean;
  /** One sentence a reader can act on for a failed call: what went wrong and who can fix it. */
  describeFailure(error: unknown): string;
}
