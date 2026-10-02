import type { Chat, SessionStatus } from "@artfct-ai/adapters/chat/types";
import type { Documents } from "@artfct-ai/adapters/docs/types";
import type {
  ActivityOptions,
  AgentActivityContent,
  Tracker,
} from "@artfct-ai/adapters/tracker/types";
import type { Acknowledge, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskEvent } from "../workflow/task/events";
import type { BoardChannel } from "../workflow/board/types";
import { DELIVERY_ERROR } from "../workflow/store/schema";
import type { Destination } from "./destination";
import { plainText, trackerContent } from "./messages";

type TrackerTarget = Extract<ReplyTarget, { source: "tracker" }>;
type DocsTarget = Extract<ReplyTarget, { source: "docs" }>;

/** A chat thread as a reply target. */
export type ChatTarget = Extract<ReplyTarget, { source: "chat" }>;

/** The tracker issue an update is about. The team is needed to look up its workflow states. */
export type IssueRef = { issue_id: string; team_id?: string | null };

/** What an outbox entry was addressed to: a reply target, an issue, or a board's place. */
export type OutboxTarget = ReplyTarget | IssueRef | BoardChannel;

export type OutboxEntry = { channel: string; kind: string; target: OutboxTarget; payload: unknown };
export type OutboxWriter = (entry: OutboxEntry) => void;
export type IssueTransition = "started" | "completed";

/** One issue update: a state transition, a delegation to the agent, or both. */
type IssueChange = {
  transition: IssueTransition | null;
  delegate: boolean;
};

/** How a post treats the agent session of the chat thread. */
export type PostOptions = {
  /** True once the workflow accepts no more work. The session is then closed, else active. */
  finished?: boolean;
  /** Leave the session status as it is. For replies on a workflow that is already finished. */
  keepSession?: boolean;
  /** The title the thread keeps once it leaves its working state. The workflow's name. */
  title?: string;
};

/** The tracker response that closes a session the agent had nothing to say on. */
export const TRACKER_RELEASE_TEXT = "Noted. Nothing to report right now.";

/** At most one chat progress message per thread in this window. */
export const CHAT_PROGRESS_INTERVAL_MS = 60_000;

/** Seconds of silence after a chat message before the eyes reaction says it was received. */
export const CHAT_ACK_DELAY_S = 10;

/**
 * The channels the notifier posts through. A channel without credentials is null. The tracker
 * and the document host are read on each use, so one installed later is found.
 */
export type ChannelClients = {
  tracker: () => Promise<Tracker | null>;
  chat: Chat | null;
  docs: () => Promise<Documents | null>;
};

/** Construction options. `now` is a seam for the progress throttle in tests. */
export type NotifierOptions = { now?: () => number };

/**
 * Turns task events into channel API calls. Every post is also written to the outbox, which is
 * the only sink when a channel has no credentials.
 */
export class Notifier {
  private tracker: () => Promise<Tracker | null>;
  private chat: Chat | null;
  private docs: () => Promise<Documents | null>;
  private lastChatProgress = new Map<string, number>();
  private now: () => number;

  constructor(
    clients: ChannelClients,
    private outbox: OutboxWriter,
    options: NotifierOptions = {},
  ) {
    this.tracker = clients.tracker;
    this.chat = clients.chat;
    this.docs = clients.docs;
    this.now = options.now ?? Date.now;
  }

  /** True when a board edit failed because someone deleted the message it was editing. */
  async boardGone(channel: BoardChannel, error: unknown): Promise<boolean> {
    switch (channel.source) {
      case "chat":
        return this.chat?.isGone(error) ?? false;
      case "tracker":
        return (await this.tracker())?.isGone(error) ?? false;
      default: {
        const unhandled: never = channel;
        throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** Deliver one event to one target. Delivery errors go to the outbox, never to the caller. */
  async post(target: ReplyTarget, event: TaskEvent, options: PostOptions = {}): Promise<void> {
    try {
      switch (target.source) {
        case "tracker":
          return await this.toTracker(target, event);
        case "chat":
          return await this.toChat(target, event, options);
        case "docs":
          return await this.toDocs(target, event);
        case "code":
          return;
      }
    } catch (error) {
      this.outbox({ channel: target.source, kind: DELIVERY_ERROR, target, payload: String(error) });
    }
  }

  /** An event that stays off the channel, recorded in the outbox under its destination. */
  async quiet(
    target: ReplyTarget,
    event: TaskEvent,
    destination: Exclude<Destination, "channel">,
  ): Promise<void> {
    this.outbox({
      channel: destination,
      kind: event.type,
      target,
      payload: { text: plainText(event) },
    });
  }

  /**
   * Post a board message and return its id. Throws on failure. Without a client the outbox is
   * the board and the id is local.
   */
  async createBoard(channel: BoardChannel, text: string): Promise<string> {
    this.outbox({ channel: "board", kind: "create", target: channel, payload: { text } });
    switch (channel.source) {
      case "chat": {
        if (!this.chat) return `local:${channel.source}`;
        const posted = await this.chat.postThreadMessage(channel.channel, channel.thread, text);
        return posted.ts;
      }
      case "tracker": {
        const tracker = await this.tracker();
        if (!tracker) return `local:${channel.source}`;
        return (await tracker.commentOnIssue(channel.issue_id, text)).id;
      }
      default: {
        const unhandled: never = channel;
        throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** Replace the text of a board message. Throws on failure, with the API's own error text. */
  async editBoard(channel: BoardChannel, messageId: string, text: string): Promise<void> {
    this.outbox({ channel: "board", kind: "edit", target: channel, payload: { text, messageId } });
    switch (channel.source) {
      case "chat":
        if (this.chat) await this.chat.updateMessage(channel.channel, messageId, text);
        return;
      case "tracker":
        await (await this.tracker())?.updateComment(messageId, text);
        return;
      default: {
        const unhandled: never = channel;
        throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** Delete a board message. Throws on failure, with the API's own error text. */
  async deleteBoard(channel: BoardChannel, messageId: string): Promise<void> {
    this.outbox({ channel: "board", kind: "delete", target: channel, payload: { messageId } });
    switch (channel.source) {
      case "chat":
        if (this.chat) await this.chat.deleteMessage(channel.channel, messageId);
        return;
      case "tracker":
        await (await this.tracker())?.deleteComment(messageId);
        return;
      default: {
        const unhandled: never = channel;
        throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** A link to a board message. Throws on failure and without a client, which has no links. */
  async boardPermalink(channel: BoardChannel, messageId: string): Promise<string> {
    switch (channel.source) {
      case "chat":
        if (!this.chat) throw new Error("board permalink: no chat client");
        return this.chat.permalink(channel.channel, messageId);
      case "tracker": {
        const tracker = await this.tracker();
        if (!tracker) throw new Error("board permalink: no tracker client");
        return tracker.commentPermalink(messageId);
      }
      default: {
        const unhandled: never = channel;
        throw new Error(`unhandled board channel ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /**
   * Mark a chat message as received by putting the thread in its processing state. A long wait
   * gets the reaction later, from `ackReaction`. Never throws.
   */
  async acknowledge(target: ChatTarget, ack: Acknowledge, title: string): Promise<void> {
    this.outbox({
      channel: "chat",
      kind: "acknowledge",
      target,
      payload: { message: ack.message, user: ack.user ?? null, title },
    });
    if (!this.chat) return;
    await this.setChatSession(target, "processing", { title, initiatorUserId: ack.user });
  }

  /** React to a message the thread is still waiting on. Never throws. */
  async ackReaction(target: ChatTarget, message: string): Promise<void> {
    this.outbox({ channel: "chat", kind: "ack_reaction", target, payload: { message } });
    if (!this.chat) return;
    try {
      await this.chat.addReaction(target.channel, message, "eyes");
    } catch (error) {
      console.warn(`chat acknowledge reaction failed: ${String(error)}`);
    }
  }

  /**
   * Show what the agent is doing while a turn runs: a processing title on the chat, an
   * ephemeral thought on the tracker. Neither is a message. Never throws.
   */
  async working(target: ReplyTarget, text: string): Promise<void> {
    switch (target.source) {
      case "chat":
        this.outbox({ channel: "chat", kind: "working", target, payload: { text } });
        return this.setChatSession(target, "processing", { title: text });
      case "tracker":
        this.outbox({ channel: "tracker", kind: "working", target, payload: { text } });
        return this.trackerActivity(target, { type: "thought", body: text }, { ephemeral: true });
      case "docs":
      case "code":
        return;
    }
  }

  /**
   * Take the target out of its working state after a turn with nothing to say. The chat gets a
   * status change, the tracker a short response, a finished workflow nothing.
   */
  async release(target: ReplyTarget, finished: boolean, title: string): Promise<void> {
    switch (target.source) {
      case "chat":
        this.outbox({ channel: "chat", kind: "release", target, payload: { finished } });
        return this.setChatSession(target, finished ? "closed" : "active", { title });
      case "tracker":
        if (finished) return;
        this.outbox({ channel: "tracker", kind: "release", target, payload: { finished } });
        return this.trackerActivity(target, { type: "response", body: TRACKER_RELEASE_TEXT });
      case "docs":
      case "code":
        return;
    }
  }

  /** Move the tracker issue: "started" on planning, "completed" on done. */
  async moveIssue(issue: IssueRef, transition: IssueTransition): Promise<void> {
    await this.updateIssue(issue, { transition, delegate: false });
  }

  /**
   * Claim an issue for a task: move it to the team's first started state unless it is there
   * already, and make the agent its delegate.
   */
  async claimIssue(issue: IssueRef, options: { started: boolean }): Promise<void> {
    const transition = options.started ? null : "started";
    await this.updateIssue(issue, { transition, delegate: true });
  }

  /**
   * Attach a chat thread to the issue a task claimed, so a reader of the issue finds the work.
   * Recorded in the outbox, errors included. Never throws.
   */
  async linkChatThread(issue: IssueRef, target: ChatTarget): Promise<void> {
    this.outbox({
      channel: "tracker",
      kind: "attach_chat_thread",
      target: issue,
      payload: { channel: target.channel, thread: target.thread },
    });
    const { chat } = this;
    if (!chat) return;
    try {
      const tracker = await this.tracker();
      if (!tracker) return;
      const url = await chat.permalink(target.channel, target.thread);
      await tracker.attachUrl(issue.issue_id, url);
    } catch (error) {
      this.outbox({
        channel: "tracker",
        kind: DELIVERY_ERROR,
        target: issue,
        payload: String(error),
      });
    }
  }

  /** One issue update for the whole change. Recorded in the outbox, errors included. Never throws. */
  private async updateIssue(issue: IssueRef, change: IssueChange): Promise<void> {
    try {
      const tracker = await this.tracker();
      const delegateId = change.delegate ? (tracker?.appUserId ?? null) : null;
      const payload = { to: change.transition, delegate: delegateId };
      this.outbox({ channel: "tracker", kind: "issue_update", target: issue, payload });
      if (!tracker) return;
      const stateId = await findStateId(tracker, issue, change);
      const input = {
        ...(stateId ? { stateId } : {}),
        ...(delegateId ? { delegateId } : {}),
      };
      if (Object.keys(input).length) await tracker.updateIssue(issue.issue_id, input);
    } catch (error) {
      this.outbox({
        channel: "tracker",
        kind: DELIVERY_ERROR,
        target: issue,
        payload: String(error),
      });
    }
  }

  private async toTracker(target: TrackerTarget, event: TaskEvent): Promise<void> {
    const content = trackerContent(event);
    if (!content) return;
    const ephemeral = event.type === "progress";
    const externalUrls =
      event.type === "artifact_ready"
        ? [{ url: event.url, label: event.artifact_kind }]
        : undefined;
    this.outbox({
      channel: "tracker",
      kind: content.type,
      target,
      payload: { ...content, ephemeral, externalUrls },
    });
    await (
      await this.tracker()
    )?.activity(target.session_id, content, {
      ephemeral,
      externalUrls,
    });
    if (event.type === "done") await this.moveIssue(target, "completed");
  }

  /** The session status follows the workflow state. It is set even when the message fails. */
  private async toChat(target: ChatTarget, event: TaskEvent, options: PostOptions): Promise<void> {
    if (event.type === "progress" && this.chatProgressThrottled(target)) return;
    const text = plainText(event);
    if (!text) return;
    this.outbox({ channel: "chat", kind: event.type, target, payload: { text } });
    if (!this.chat) return;
    try {
      await this.chat.postThreadReply(target.channel, target.thread, text);
    } finally {
      if (!options.keepSession) {
        const status = options.finished ? "closed" : "active";
        await this.setChatSession(target, status, { title: options.title });
      }
    }
  }

  /** One activity on a tracker session, outside `post`. A failure lands in the outbox. */
  private async trackerActivity(
    target: TrackerTarget,
    content: AgentActivityContent,
    options: ActivityOptions = {},
  ): Promise<void> {
    try {
      await (await this.tracker())?.activity(target.session_id, content, options);
    } catch (error) {
      this.outbox({ channel: "tracker", kind: DELIVERY_ERROR, target, payload: String(error) });
    }
  }

  /** A failed status call is logged and swallowed. The message itself still went out. */
  private async setChatSession(
    target: ChatTarget,
    status: SessionStatus,
    options: { title?: string; initiatorUserId?: string } = {},
  ): Promise<void> {
    if (!this.chat) return;
    try {
      await this.chat.setSessionStatus(target.channel, target.thread, status, options);
    } catch (error) {
      console.warn(`chat session status ${status} failed: ${String(error)}`);
    }
  }

  private async toDocs(target: DocsTarget, event: TaskEvent): Promise<void> {
    if (event.type === "progress") return;
    const text = plainText(event);
    if (!text) return;
    this.outbox({ channel: "docs", kind: event.type, target, payload: { text } });
    await (await this.docs())?.comment(target.page_id, text);
  }

  /** At most one progress message per thread per minute. */
  private chatProgressThrottled(target: ChatTarget): boolean {
    const key = `${target.channel}:${target.thread}`;
    const at = this.now();
    const last = this.lastChatProgress.get(key);
    if (last !== undefined && at - last < CHAT_PROGRESS_INTERVAL_MS) return true;
    this.lastChatProgress.set(key, at);
    return false;
  }
}

/** The id of the team state a transition lands in. Null without a transition or a team. */
async function findStateId(
  tracker: Tracker,
  issue: IssueRef,
  change: IssueChange,
): Promise<string | null> {
  const { transition } = change;
  if (!transition || !issue.team_id) return null;
  const states = await tracker.teamStates(issue.team_id);
  return states.find((candidate) => candidate.type === transition)?.id ?? null;
}
