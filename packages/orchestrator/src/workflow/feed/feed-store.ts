import type { ToolKind } from "@agentclientprotocol/sdk";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { BoardStore } from "../board/board-store";
import { feedItems, feedPosts } from "../store/schema";
import type { FeedActivity, FeedItem, FeedPost } from "./types";

type FeedItemRow = typeof feedItems.$inferSelect;

/** How much text one feed item keeps. A longer text keeps its end. */
export const FEED_TEXT_CHARS = 8_000;

function feedItemOf(row: FeedItemRow): FeedItem {
  if (row.kind !== "tool") return { seq: row.seq, kind: row.kind, text: row.text };
  return {
    seq: row.seq,
    kind: "tool",
    title: row.text,
    tool_kind: row.tool_kind,
    failed: row.failed === 1,
  };
}

/** Queries over the session feed: what each author streamed that its job session does not hold. */
export class FeedStore extends BoardStore {
  /** The task's feed items not rendered into a post yet, oldest first. */
  feedItems(taskId: string): FeedItem[] {
    return this.db
      .select()
      .from(feedItems)
      .where(eq(feedItems.task_id, taskId))
      .orderBy(asc(feedItems.seq))
      .all()
      .map(feedItemOf);
  }

  /** Add text to the feed. It joins the last item when that item holds text of the same kind. */
  appendFeedText(taskId: string, kind: "thought" | "message" | "error", text: string): void {
    const last = this.db
      .select()
      .from(feedItems)
      .where(eq(feedItems.task_id, taskId))
      .orderBy(desc(feedItems.seq))
      .get();
    if (last?.kind === kind) {
      this.db
        .update(feedItems)
        .set({ text: `${last.text}${text}`.slice(-FEED_TEXT_CHARS) })
        .where(eq(feedItems.seq, last.seq))
        .run();
      return;
    }
    this.db
      .insert(feedItems)
      .values({ task_id: taskId, kind, text: text.slice(-FEED_TEXT_CHARS) })
      .run();
  }

  /** Add one tool call to the feed. */
  addFeedTool(
    taskId: string,
    tool: { tool_call_id: string; title: string; tool_kind: ToolKind | null },
  ): void {
    this.db
      .insert(feedItems)
      .values({ task_id: taskId, kind: "tool", text: tool.title, ...tool })
      .run();
  }

  /** Change a tool call the feed holds. A call already rendered into a post stays as it was. */
  updateFeedTool(
    taskId: string,
    toolCallId: string,
    patch: { title?: string; failed?: boolean },
  ): void {
    const set = {
      ...(patch.title ? { text: patch.title } : {}),
      ...(patch.failed ? { failed: 1 } : {}),
    };
    if (Object.keys(set).length === 0) return;
    this.db
      .update(feedItems)
      .set(set)
      .where(and(eq(feedItems.task_id, taskId), eq(feedItems.tool_call_id, toolCallId)))
      .run();
  }

  /** Turn rendered items into posts, each under a new activity id, and drop the items. */
  queueFeedPosts(taskId: string, activities: FeedActivity[]): void {
    if (activities.length === 0) return;
    this.db
      .insert(feedPosts)
      .values(
        activities.map((activity) => ({
          task_id: taskId,
          activity_id: crypto.randomUUID(),
          content: activity.content,
        })),
      )
      .run();
    const seqs = activities.flatMap((activity) => activity.seqs);
    this.db.delete(feedItems).where(inArray(feedItems.seq, seqs)).run();
  }

  /** The task's posts that did not succeed yet, oldest first. */
  feedPosts(taskId: string): FeedPost[] {
    return this.db
      .select()
      .from(feedPosts)
      .where(eq(feedPosts.task_id, taskId))
      .orderBy(asc(feedPosts.seq))
      .all()
      .map((row) => ({ seq: row.seq, id: row.activity_id, content: row.content }));
  }

  /** Drop one post the job session now holds. */
  deleteFeedPost(seq: number): void {
    this.db.delete(feedPosts).where(eq(feedPosts.seq, seq)).run();
  }

  /** Drop every post of the task that did not succeed. */
  deleteFeedPosts(taskId: string): void {
    this.db.delete(feedPosts).where(eq(feedPosts.task_id, taskId)).run();
  }
}
