import type { Chat, ChatMessage, ChatPage } from "@artfct-ai/adapters/chat/types";
import { tool } from "ai";
import { z } from "zod";
import type { ChatTarget } from "../../notify/notifier";
import type { WorkflowRuntime } from "../../workflow/types";

/** Messages one chat read asks for when the agent names no limit. */
const CHAT_READ_LIMIT = 15;

/** Most messages one chat read may ask for. The chat host may return fewer. */
const CHAT_READ_MAX = 100;

/** Characters of one message that reach the reader. A pasted stack trace fits. */
const MAX_MESSAGE_CHARS = 1500;

/** Characters one read may add to the transcript. The oldest messages are dropped first. */
const MAX_READ_CHARS = 40_000;

/** Milliseconds a Slack timestamp can name. Anything else is not a time. */
const MAX_TIME_MS = 8.64e15;

/** What one read asks for. `threadTs` reads a thread, `beforeTs` pages a channel back in time. */
type ReadOptions = { limit: number; threadTs?: string; beforeTs?: string; cursor?: string };

/** One read: what was asked for, the cursor it came from, and what came back. */
type RenderInput = {
  scope: string;
  page: ChatPage;
  target: ChatTarget;
  thread: boolean;
  cursor?: string;
};

/** What a read left out for budget, and what the reader has to pass to reach it. */
type BudgetAdvice = { dropped: number; thread: boolean; cursor?: string; oldestKept: string };

/** Tools that read back in the channel the request came from. */
export function historyTools(workflow: WorkflowRuntime) {
  return {
    read_channel: tool({
      description: `Read earlier messages of the chat channel this request came from, oldest first. Use it before you ask a human: a request that points at something already said ("the error two posts up", "the link above") is in here, and so is what fell out of your transcript. A channel read counts back from the newest message, lists top-level messages, and names the thread of every message that has replies, this request's own thread included. Pass one of those to thread_ts to read that thread from its first message. The chat host often returns fewer messages than the limit, and one read a minute is all some apps get, so the last lines of every read say what was left out and exactly what to pass to get it: before_ts for older channel messages, cursor for the rest of a thread.`,
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(CHAT_READ_MAX)
          .default(CHAT_READ_LIMIT)
          .describe(
            `messages to ask the chat host for, ${CHAT_READ_LIMIT} by default. The host may cap this at ${CHAT_READ_LIMIT} whatever is asked for`,
          ),
        thread_ts: z
          .string()
          .optional()
          .describe("read this thread from its first message instead of the channel"),
        before_ts: z
          .string()
          .optional()
          .describe("channel reads only: read messages older than this ts"),
        cursor: z
          .string()
          .optional()
          .describe("continue a read that was cut short, with the cursor it printed"),
      }),
      execute: ({ limit, thread_ts, before_ts, cursor }) =>
        readChannel(workflow, { limit, threadTs: thread_ts, beforeTs: before_ts, cursor }),
    }),
  };
}

/** The chat thread the request came from: its origin when that is chat, else any chat target. */
function chatTarget(workflow: WorkflowRuntime): ChatTarget | null {
  const { origin, reply_targets } = workflow.state;
  if (origin?.source === "chat") return origin;
  return reply_targets.find((target) => target.source === "chat") ?? null;
}

/** Every failure is a sentence the agent can act on. This tool never throws. */
async function readChannel(workflow: WorkflowRuntime, options: ReadOptions): Promise<string> {
  const target = chatTarget(workflow);
  if (!target) return "This workflow has no chat channel. The request came from somewhere else.";
  const chat = workflow.chat();
  if (!chat) return "Chat is not configured.";
  const thread = Boolean(options.threadTs);
  const scope = options.threadTs ? `thread ${options.threadTs}` : `channel ${target.channel}`;
  try {
    const page = await readPage(chat, target.channel, options);
    return renderRead({ scope, page, target, thread, cursor: options.cursor });
  } catch (error) {
    return `Could not read ${scope}: ${chat.describeFailure(error)}`;
  }
}

function readPage(chat: Chat, channel: string, options: ReadOptions): Promise<ChatPage> {
  const { limit, cursor } = options;
  if (options.threadTs) return chat.threadReplies(channel, options.threadTs, { limit, cursor });
  return chat.channelHistory(channel, { limit, cursor, before: options.beforeTs });
}

function renderRead({ scope, page, target, thread, cursor }: RenderInput): string {
  const note = thread ? [] : [`The thread this request came from is thread_ts=${target.thread}.`];
  const { messages } = page;
  if (!messages.length) return [`No messages in ${scope}.`, ...note].join("\n");
  const { kept, dropped } = keepNewestWithinBudget(messages.map(messageLine));
  return [
    `${kept.length} message(s) from ${scope}, oldest first.`,
    ...note,
    ...kept,
    ...budgetLine({ dropped, thread, cursor, oldestKept: messages[dropped]?.ts ?? "" }),
    ...moreLine(page, thread, dropped),
  ].join("\n");
}

/** What this read had to leave out to stay inside the transcript budget, and how to reach it. */
function budgetLine({ dropped, thread, cursor, oldestKept }: BudgetAdvice): string[] {
  if (!dropped) return [];
  const left = `${dropped} message(s) left out to stay in budget`;
  if (thread) {
    const from = cursor ? `cursor=${cursor} and ` : "";
    return [`${left}, the earliest of this page. Read them with ${from}a smaller limit.`];
  }
  return [`${left}, the oldest of this page. Read them with before_ts=${oldestKept}.`];
}

/** What the chat host itself held back, and the cursor that continues from here. */
function moreLine(page: ChatPage, thread: boolean, dropped: number): string[] {
  if (!page.hasMore) return [];
  if (!thread && dropped) return [];
  const rest = thread
    ? "This thread has more replies"
    : "The chat host has messages older than this page";
  if (page.cursor) return [`${rest}. Read them with cursor=${page.cursor}.`];
  return [`${rest}, and the chat host named no cursor for them.`];
}

function messageLine(message: ChatMessage): string {
  const thread = message.replyCount ? ` thread=${message.ts} replies=${message.replyCount}` : "";
  const from = message.user ?? "unknown";
  return `- ts=${message.ts} at=${isoTime(message.ts)} from=${from}${thread}: ${shortenMessage(message.text)}`;
}

/** A Slack timestamp is Unix seconds with microseconds after the dot. */
function isoTime(ts: string): string {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) return "unknown";
  return new Date(ms).toISOString();
}

function shortenMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_MESSAGE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MESSAGE_CHARS)}... [message cut at ${MAX_MESSAGE_CHARS} characters]`;
}

/** The newest lines that fit the budget, oldest first, with how many were dropped. */
export function keepNewestWithinBudget(lines: string[]): { kept: string[]; dropped: number } {
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    total += lines[index]!.length + 1;
    if (total > MAX_READ_CHARS) break;
    kept.unshift(lines[index]!);
  }
  return { kept, dropped: lines.length - kept.length };
}
