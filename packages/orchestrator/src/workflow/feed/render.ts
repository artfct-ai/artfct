import type { ToolKind } from "@agentclientprotocol/sdk";
import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";
import type { FeedActivity, FeedItem } from "./types";

/** The most characters one feed activity carries. A longer body keeps its start. */
export const FEED_BODY_CHARS = 10_000;

const TOOL_VERBS: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
  other: "Tool",
};

/** The verb a tool call shows under in its job session. */
export function toolVerb(kind: ToolKind | null): string {
  return TOOL_VERBS[kind ?? "other"];
}

function clipBody(text: string): string {
  return text.length <= FEED_BODY_CHARS ? text : `${text.slice(0, FEED_BODY_CHARS - 1)}…`;
}

function toolLine(item: Extract<FeedItem, { kind: "tool" }>): string {
  const failed = item.failed ? " (failed)" : "";
  return `${toolVerb(item.tool_kind)}: ${item.title}${failed}`;
}

/** The activity of one item on its own. A message before the turn's end reads as a thought. */
function itemContent(item: FeedItem): AgentActivityContent {
  switch (item.kind) {
    case "thought":
    case "message":
      return { type: "thought", body: clipBody(item.text) };
    case "error":
      return { type: "error", body: clipBody(item.text) };
    case "tool":
      return {
        type: "action",
        action: toolVerb(item.tool_kind),
        parameter: item.title,
        ...(item.failed ? { result: "failed" } : {}),
      };
    default: {
      const unhandled: never = item;
      throw new Error(`unhandled feed item ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Several items as one thought, in order. */
function batchContent(items: FeedItem[]): AgentActivityContent {
  const lines = items.map((item) => (item.kind === "tool" ? `- ${toolLine(item)}` : item.text));
  return { type: "thought", body: clipBody(lines.join("\n\n")) };
}

function batchActivity(items: FeedItem[]): FeedActivity[] {
  const [first] = items;
  if (!first) return [];
  const content = items.length === 1 ? itemContent(first) : batchContent(items);
  return [{ content, seqs: items.map((item) => item.seq) }];
}

/** The closing activity: a message as the reply, an error as the error. */
function closingActivity(item: FeedItem): FeedActivity {
  const content: AgentActivityContent =
    item.kind === "error"
      ? { type: "error", body: clipBody(item.text) }
      : { type: "response", body: clipBody(item.kind === "tool" ? toolLine(item) : item.text) };
  return { content, seqs: [item.seq] };
}

/**
 * The activities that post the items. Without a closing they post as one activity. With one, the
 * last item becomes the closing reply or error, after one activity for everything before it.
 */
export function renderFeed(items: FeedItem[], closing: boolean): FeedActivity[] {
  const last = items.at(-1);
  if (!closing || !last) return batchActivity(items);
  return [...batchActivity(items.slice(0, -1)), closingActivity(last)];
}
