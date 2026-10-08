import type { ChatMessage, ChatPage } from "../types";
import { mentionedUserIds } from "./mentions";

/** Messages one history read asks for when the caller names no limit. Slack's own per-call cap. */
const SLACK_HISTORY_LIMIT = 15;

/** Most messages one history read may ask for. Only an app on the older rate tier gets them all. */
const SLACK_HISTORY_MAX = 100;

/** The fields of a history or replies message this adapter reads. */
type RawMessage = {
  ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
};

/** The envelope both history methods answer with. */
type RawPage = {
  messages?: RawMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

/** One Slack page as a `ChatPage`, in the order Slack sent it. */
export function toChatPage(payload: RawPage): ChatPage {
  return {
    messages: (payload.messages ?? []).map(toMessage),
    hasMore: payload.has_more ?? false,
    cursor: payload.response_metadata?.next_cursor || null,
  };
}

/** One Slack page as a `ChatPage`, oldest message first. Slack lists a channel newest first. */
export function toChatPageOldestFirst(payload: RawPage): ChatPage {
  const page = toChatPage(payload);
  return { ...page, messages: page.messages.toReversed() };
}

function toMessage(message: RawMessage): ChatMessage {
  const text = message.text ?? "";
  return {
    ts: message.ts ?? "",
    user: message.user ?? message.username ?? message.bot_id ?? null,
    text,
    replyCount: message.reply_count ?? 0,
    mentions: mentionedUserIds(text),
  };
}

/** A limit Slack accepts: at least one message, never more than `SLACK_HISTORY_MAX`. */
export function historyLimit(limit: number | undefined): number {
  const wanted = limit ?? SLACK_HISTORY_LIMIT;
  return Math.min(Math.max(Math.trunc(wanted), 1), SLACK_HISTORY_MAX);
}
