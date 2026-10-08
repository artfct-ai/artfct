import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { workerdFetch } from "../../workerd-fetch";
import { describeSlackFailure } from "./failures";
import { historyLimit, toChatPage, toChatPageOldestFirst } from "./history";
import { toSlackMrkdwn } from "./mrkdwn";
import type { ChatUser } from "@artfct-ai/contracts/types";
import type { Chat, ChatPage, HistoryOptions, SessionOptions, SessionStatus } from "../types";

const SESSION_TITLE_LIMIT = 200;

/** Most characters one Slack message carries. Slack itself refuses text above 4000. */
export const SLACK_TEXT_LIMIT = 3900;

/** Split text into chunks under `limit` at paragraph boundaries, then line boundaries. */
export function splitSlackText(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = boundaryBefore(rest, limit);
    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function boundaryBefore(text: string, limit: number): number {
  const paragraph = text.lastIndexOf("\n\n", limit);
  if (paragraph > 0) return paragraph;
  const line = text.lastIndexOf("\n", limit);
  if (line > 0) return line;
  return limit;
}

/** Construction options. `apiUrl` and `fetch` are seams for tests. */
export type SlackOptions = { apiUrl?: string; fetch?: typeof fetch };

/**
 * `Chat` over the Slack Web API for a bot token. Retries are off and a rate limit is refused
 * at once, so no call sleeps inside a Durable Object.
 */
export class SlackChat implements Chat {
  private readonly web: WebClient;

  constructor(botToken: string, options: SlackOptions = {}) {
    this.web = new WebClient(botToken, {
      slackApiUrl: options.apiUrl?.replace(/\/?$/, "/"),
      fetch: workerdFetch(options.fetch),
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  }

  /** Reply in a thread. Long text goes out as several replies. Returns the first one. */
  async postThreadReply(channel: string, threadTs: string, text: string): Promise<{ ts: string }> {
    const [head = "", ...rest] = splitSlackText(toSlackMrkdwn(text));
    const first = await this.postToThread(channel, threadTs, head);
    for (const chunk of rest) await this.postToThread(channel, threadTs, chunk);
    return first;
  }

  /** Post one thread message as is, never split. */
  async postThreadMessage(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string }> {
    return this.postToThread(channel, threadTs, toSlackMrkdwn(text));
  }

  /** Post in the channel itself, outside any thread. */
  async postChannelMessage(channel: string, text: string): Promise<void> {
    await this.chatPostMessage({ channel, text: toSlackMrkdwn(text) });
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.web.chat.update({ channel, ts, text: toSlackMrkdwn(text) });
  }

  /** Delete one message by channel and timestamp. */
  async deleteMessage(channel: string, ts: string): Promise<void> {
    await this.web.chat.delete({ channel, ts });
  }

  /** One threaded `chat.postMessage` for text that is already mrkdwn. */
  private async postToThread(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string }> {
    const posted = await this.chatPostMessage({ channel, thread_ts: threadTs, text });
    if (!posted.ts) throw new Error("slack chat.postMessage: response carries no ts");
    return { ts: posted.ts };
  }

  private chatPostMessage(request: { channel: string; text: string; thread_ts?: string }) {
    // Slack's chat.postMessage, not window.postMessage. The unicorn rule cannot tell them apart.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    return this.web.chat.postMessage(request);
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.web.reactions.add({ channel, timestamp: ts, name });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.web.reactions.remove({ channel, timestamp: ts, name });
  }

  /** Set the agent session status on a thread. The app needs Slack's Agents feature. */
  async setSessionStatus(
    channel: string,
    threadTs: string,
    status: SessionStatus,
    options: SessionOptions = {},
  ): Promise<void> {
    await this.web.agents.sessions.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status,
      title: options.title?.slice(0, SESSION_TITLE_LIMIT),
      initiator_user_id: options.initiatorUserId,
    });
  }

  async threadRootTs(channel: string, ts: string): Promise<string> {
    const replies = await this.web.conversations.replies({ channel, ts, limit: 1 });
    const messages = replies.messages ?? [];
    const message = messages.find((entry) => entry.ts === ts) ?? messages[0];
    return message?.thread_ts ?? ts;
  }

  async permalink(channel: string, ts: string): Promise<string> {
    const link = await this.web.chat.getPermalink({ channel, message_ts: ts });
    if (!link.permalink) throw new Error("slack chat.getPermalink: response carries no permalink");
    return link.permalink;
  }

  async user(userId: string): Promise<ChatUser | null> {
    const info = await this.web.users.info({ user: userId }).catch(() => null);
    const user = info?.user;
    if (!user) return null;
    const guestOrBot =
      user.is_restricted || user.is_ultra_restricted || user.is_bot || user.deleted;
    return {
      id: userId,
      email: user.profile?.email ?? null,
      member_of_team: guestOrBot ? null : (user.team_id ?? null),
    };
  }

  /**
   * The most recent channel messages, oldest first. `before` and the cursor both walk further
   * into the past, and the cursor is sent alone because Slack ignores `before` beside it.
   */
  async channelHistory(channel: string, options: HistoryOptions = {}): Promise<ChatPage> {
    const page = await this.web.conversations.history({
      channel,
      limit: historyLimit(options.limit),
      ...(options.cursor ? { cursor: options.cursor } : { latest: options.before }),
    });
    return toChatPageOldestFirst(page);
  }

  /** A thread from its start: the message it hangs off, then its replies. Pages forward only. */
  async threadReplies(
    channel: string,
    threadTs: string,
    options: HistoryOptions = {},
  ): Promise<ChatPage> {
    const page = await this.web.conversations.replies({
      channel,
      ts: threadTs,
      limit: historyLimit(options.limit),
      cursor: options.cursor,
    });
    return toChatPage(page);
  }

  /** True when Slack answered `message_not_found`. */
  isGone(error: unknown): boolean {
    return error instanceof WebAPIPlatformError && error.data.error === "message_not_found";
  }

  describeFailure(error: unknown): string {
    return describeSlackFailure(error);
  }
}
