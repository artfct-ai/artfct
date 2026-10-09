import type { ToolKind } from "@agentclientprotocol/sdk";
import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";

/** What a feed item holds: text the author thought or said, one tool call, or a turn's error. */
export type FeedItemKind = "thought" | "message" | "tool" | "error";

/** One item of an author's session feed that is not rendered into a post yet. */
export type FeedItem =
  | { seq: number; kind: "thought" | "message" | "error"; text: string }
  | { seq: number; kind: "tool"; title: string; tool_kind: ToolKind | null; failed: boolean };

/** One activity rendered from feed items, and the items it carries. */
export type FeedActivity = { content: AgentActivityContent; seqs: number[] };

/** A rendered activity waiting to post under its id. */
export type FeedPost = { seq: number; id: string; content: AgentActivityContent };

/**
 * How a turn closes the feed when the author goes idle. A `reply` posts the author's last message,
 * or `fallback` when the author said nothing after its last tool call. An `error` says why the
 * turn did not finish.
 */
export type FeedClosing = { kind: "reply"; fallback: string } | { kind: "error"; text: string };
