import type { Chat, SessionStatus } from "@artfct-ai/adapters/chat/types";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { Acknowledge, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskEvent } from "../workflow/task/events";
import type { BoardChannel } from "../workflow/board/types";
import { DELIVERY_ERROR } from "../workflow/store/schema";
import type { Destination } from "./destination";
import { plainText, trackerContent } from "./messages";

type TrackerTarget = Extract<ReplyTarget, { source: "tracker" }>;
type DocumentsTarget = Extract<ReplyTarget, { source: "documents" }>;

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

/** At most one chat progress message per thread in this window. */
export const CHAT_PROGRESS_INTERVAL_MS = 60_000;

/**
 * The channels the notifier posts through. A channel without credentials is null. The tracker
 * and the document host are read on each use, so one installed later is found.
 */
export type ChannelClients = {
  tracker: () => Promise<Tracker | null>;
  chat: Chat | null;
  documents: () => Promise<Documents | null>;
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
  private documents: () => Promise<Documents | null>;
  private lastChatProgress = new Map<string, number>();
  private now: () => number;

  constructor(
    clients: ChannelClients,
    private outbox: OutboxWriter,
    options: NotifierOptions = {},
  ) {
    this.tracker = clients.tracker;
    this.chat = clients.chat;
    this.documents = clients.documents;
    this.now = options.now ?? Date.now;
  }

  /** True when a board edit failed because someone deleted the message it was editing. */
  boardGone(error: unknown): boolean {
    return this.chat?.isGone(error) ?? false;
  }

  /** Deliver one event to one target. Delivery errors go to the outbox, never to the caller. */
  async post(target: ReplyTarget, event: TaskEvent, options: PostOptions = {}): Promise<void> {
    try {
      switch (target.source) {
        case "tracker":
          return await this.toTracker(target, event);
        case "chat":
          return await this.toChat(target, event, options);
        case "documents":
          return await this.toDocuments(target, event);
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
   * Post a board message and return its id. Throws on failure. Without a chat client the outbox
   * is the board and the id is local.
   */
  async createBoard(channel: BoardChannel, text: string): Promise<string> {
    this.outbox({ channel: "board", kind: "create", target: channel, payload: { text } });
    if (!this.chat) return `local:${channel.source}`;
    const posted = await this.chat.postThreadMessage(channel.channel, channel.thread, text);
    return posted.ts;
  }

  /** Replace the text of a board message. Throws on failure, with the API's own error text. */
  async editBoard(channel: BoardChannel, messageId: string, text: string): Promise<void> {
    this.outbox({ channel: "board", kind: "edit", target: channel, payload: { text, messageId } });
    await this.chat?.updateMessage(channel.channel, messageId, text);
  }

  /** Delete a board message. Throws on failure, with the API's own error text. */
  async deleteBoard(channel: BoardChannel, messageId: string): Promise<void> {
    this.outbox({ channel: "board", kind: "delete", target: channel, payload: { messageId } });
    await this.chat?.deleteMessage(channel.channel, messageId);
  }

  /** A link to a board message. Throws on failure and without a chat client, which has no links. */
  async boardPermalink(channel: BoardChannel, messageId: string): Promise<string> {
    if (!this.chat) throw new Error("board permalink: no chat client");
    return this.chat.permalink(channel.channel, messageId);
  }

  /** Mark a chat message as received by putting the thread in its processing state. Never throws. */
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

  /**
   * Show a chat thread what the agent is doing while a turn runs, as its processing title. It is
   * not a message. Never throws.
   */
  async working(target: ChatTarget, text: string): Promise<void> {
    this.outbox({ channel: "chat", kind: "working", target, payload: { text } });
    await this.setChatSession(target, "processing", { title: text });
  }

  /** Take a chat thread out of its working status after a turn with nothing to say. Never throws. */
  async release(target: ChatTarget, finished: boolean, title: string): Promise<void> {
    this.outbox({ channel: "chat", kind: "release", target, payload: { finished } });
    await this.setChatSession(target, finished ? "closed" : "active", { title });
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
   * Sync a chat thread into the issue a task claimed, so the issue's comments carry the thread.
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
      await tracker.syncChatThread(issue.issue_id, url);
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

  private async toDocuments(target: DocumentsTarget, event: TaskEvent): Promise<void> {
    if (event.type === "progress") return;
    const text = plainText(event);
    if (!text) return;
    this.outbox({ channel: "documents", kind: event.type, target, payload: { text } });
    await (await this.documents())?.comment(target.page_id, text);
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
