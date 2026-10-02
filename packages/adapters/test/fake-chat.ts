import type {
  Chat,
  ChatPage,
  HistoryOptions,
  SessionOptions,
  SessionStatus,
} from "../src/chat/types";
import type { ChatUser } from "@artfct-ai/contracts/types";
import { CallLog, type RecordedCall } from "./calls";

/** Fixed answers for a `FakeChat`. */
export type ChatAnswers = {
  /** Thread root per message ts. A ts not listed is its own root. */
  threadRoots?: Record<string, string>;
  /** The user per user id. A user id not listed has no answer. */
  users?: Record<string, ChatUser>;
  /** Permalink per message ts. A ts not listed gets a link built from the channel and the ts. */
  permalinks?: Record<string, string>;
  /** The page every channel read returns. Default: an empty page. */
  history?: ChatPage;
  /** The page every thread read returns. Default: an empty page. */
  replies?: ChatPage;
  /** Every call fails. */
  failing?: boolean;
  /** Errors `isGone` recognizes. Default: any error whose text includes `not found`. */
  gone?: (error: unknown) => boolean;
};

/** Methods a `FakeChat` records. */
export type ChatMethod = Exclude<keyof Chat, "isGone" | "describeFailure">;

const EMPTY_PAGE: ChatPage = { messages: [], hasMore: false, cursor: null };

/** An in-memory `Chat` that records every call. Posted messages get sequential timestamps. */
export class FakeChat implements Chat {
  private readonly log: CallLog<ChatMethod>;
  private posted = 0;

  constructor(private readonly answers: ChatAnswers = {}) {
    this.log = new CallLog(answers.failing ?? false);
  }

  get calls(): RecordedCall<ChatMethod>[] {
    return this.log.calls;
  }

  argsOf(method: ChatMethod): unknown[][] {
    return this.log.argsOf(method);
  }

  async postThreadReply(channel: string, threadTs: string, text: string): Promise<{ ts: string }> {
    this.log.record("postThreadReply", channel, threadTs, text);
    return { ts: this.nextTs() };
  }

  async postThreadMessage(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string }> {
    this.log.record("postThreadMessage", channel, threadTs, text);
    return { ts: this.nextTs() };
  }

  async postChannelMessage(channel: string, text: string): Promise<void> {
    this.log.record("postChannelMessage", channel, text);
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    this.log.record("updateMessage", channel, ts, text);
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    this.log.record("deleteMessage", channel, ts);
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    this.log.record("addReaction", channel, ts, name);
  }

  async setSessionStatus(
    channel: string,
    threadTs: string,
    status: SessionStatus,
    options: SessionOptions = {},
  ): Promise<void> {
    this.log.record("setSessionStatus", channel, threadTs, status, options);
  }

  async threadRootTs(channel: string, ts: string): Promise<string> {
    this.log.record("threadRootTs", channel, ts);
    return this.answers.threadRoots?.[ts] ?? ts;
  }

  async permalink(channel: string, ts: string): Promise<string> {
    this.log.record("permalink", channel, ts);
    return this.answers.permalinks?.[ts] ?? `https://chat.test/${channel}/${ts}`;
  }

  async user(userId: string): Promise<ChatUser | null> {
    this.log.record("user", userId);
    return this.answers.users?.[userId] ?? null;
  }

  async channelHistory(channel: string, options: HistoryOptions = {}): Promise<ChatPage> {
    this.log.record("channelHistory", channel, options);
    return this.answers.history ?? EMPTY_PAGE;
  }

  async threadReplies(
    channel: string,
    threadTs: string,
    options: HistoryOptions = {},
  ): Promise<ChatPage> {
    this.log.record("threadReplies", channel, threadTs, options);
    return this.answers.replies ?? EMPTY_PAGE;
  }

  isGone(error: unknown): boolean {
    return this.answers.gone ? this.answers.gone(error) : String(error).includes("not found");
  }

  /** The error's own message, so a test can match on what the fake threw. */
  describeFailure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private nextTs(): string {
    this.posted += 1;
    return `${1700000000 + this.posted}.000100`;
  }
}
