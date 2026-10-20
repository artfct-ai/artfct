import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";

/** The kind of step a session feed post landed in. */
export type FeedStepKind =
  | "stream"
  | "tick"
  | "turn_start"
  | "turn_end"
  | "stop"
  | "instruction"
  | "restart";

/**
 * One activity the tracker stored. `acknowledged` is false when the orchestrator never saw the
 * tracker take it: a restart cut the post, or the tracker failed after it stored it.
 */
export type FeedPost = {
  at: number;
  step: FeedStepKind;
  type: AgentActivityContent["type"];
  body: string;
  ephemeral: boolean;
  acknowledged: boolean;
};

/** The text that joins the narration lines one post carries. */
const NARRATION_LINE_SEPARATOR = "\n\n";

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

function isNarration(post: FeedPost): boolean {
  return post.type === "thought" && !post.ephemeral;
}

function narrationLines(post: FeedPost): string[] {
  return post.body.split(NARRATION_LINE_SEPARATOR);
}

/** A tool call never posts: no action reaches the feed, and no post names a tool call's title. */
export function aToolCallNeverPosts(posts: FeedPost[], toolTitles: string[]): void {
  for (const post of posts) {
    if (post.type === "action") violated("aToolCallNeverPosts", `an action posted: ${post.body}`);
    const title = toolTitles.find((toolTitle) => post.body.includes(toolTitle));
    if (title) violated("aToolCallNeverPosts", `a ${post.type} named the tool call ${title}`);
  }
}

/**
 * Narration posts at most once per interval. Only the post as a turn ends or stops comes sooner.
 * A post the orchestrator never saw land does not start the interval.
 */
export function narrationPostsAtMostOncePerInterval(posts: FeedPost[], intervalMs: number): void {
  let lastAcknowledgedAt: number | null = null;
  for (const post of posts.filter(isNarration)) {
    const turnEnds = post.step === "turn_end" || post.step === "stop";
    if (!turnEnds && lastAcknowledgedAt !== null && post.at - lastAcknowledgedAt < intervalMs) {
      violated(
        "narrationPostsAtMostOncePerInterval",
        `narration posted ${post.at - lastAcknowledgedAt} ms after the last`,
      );
    }
    if (post.acknowledged) lastAcknowledgedAt = post.at;
  }
}

/**
 * Every narration line the author wrote posts, in the order it was written. A line posts again
 * only after a post that carried it did not land for the orchestrator.
 */
export function everyNarrationLinePostsInOrder(posts: FeedPost[], written: string[]): void {
  const posted: string[] = [];
  const unacknowledged = new Set<string>();
  for (const post of posts.filter(isNarration)) {
    for (const line of narrationLines(post)) {
      if (!posted.includes(line)) posted.push(line);
      else if (!unacknowledged.has(line)) {
        violated("everyNarrationLinePostsInOrder", `the line ${line} posted twice`);
      }
      if (!post.acknowledged) unacknowledged.add(line);
    }
  }
  if (posted.join("|") !== written.join("|")) {
    violated(
      "everyNarrationLinePostsInOrder",
      `posted ${JSON.stringify(posted)}, written ${JSON.stringify(written)}`,
    );
  }
}

/** The reply that closes a turn never also posts as narration. */
export function theReplyNeverPostsAsNarration(posts: FeedPost[], replies: string[]): void {
  for (const post of posts.filter(isNarration)) {
    const reply = replies.find((text) => narrationLines(post).some((line) => line.includes(text)));
    if (reply) violated("theReplyNeverPostsAsNarration", `the reply ${reply} posted as narration`);
  }
}

/**
 * During a turn, the feed is never quiet for the heartbeat's span after a tick, while the tracker
 * takes posts and the quota is not low. `quietSince` is when the feed last showed activity, or
 * when posts last became possible.
 */
export function aQuietTurnGetsAHeartbeat(
  now: number,
  quietSince: number,
  heartbeatAfterMs: number,
): void {
  if (now - quietSince >= heartbeatAfterMs) {
    violated("aQuietTurnGetsAHeartbeat", `the feed was quiet for ${now - quietSince} ms`);
  }
}

/** A tick posts the narration that is due, whatever the quota. Only heartbeats wait on it. */
export function onlyHeartbeatsWaitOnTheQuota(dueNarrationWaits: boolean, quotaLow: boolean): void {
  if (dueNarrationWaits) {
    violated(
      "onlyHeartbeatsWaitOnTheQuota",
      `due narration still waits after a tick, with the quota ${quotaLow ? "low" : "not low"}`,
    );
  }
}

/** A tick while the quota is low posts no heartbeat. */
export function heartbeatsWaitWhileTheQuotaIsLow(tickPosts: FeedPost[], quotaLow: boolean): void {
  const heartbeat = tickPosts.find((post) => post.ephemeral);
  if (quotaLow && heartbeat) {
    violated("heartbeatsWaitWhileTheQuotaIsLow", `a heartbeat posted: ${heartbeat.body}`);
  }
}

/**
 * A person's message to a running author reaches the author's prompt queue, and the person gets
 * one receipt as an ephemeral thought.
 */
export function everyInstructionToARunningAuthorGetsAReceipt(
  stepPosts: FeedPost[],
  queued: boolean,
  receiptText: string,
): void {
  if (!queued) {
    violated(
      "everyInstructionToARunningAuthorGetsAReceipt",
      "the message did not reach the author",
    );
  }
  const receipts = stepPosts.filter(
    (post) => post.type === "thought" && post.ephemeral && post.body === receiptText,
  );
  if (receipts.length !== 1 || stepPosts.length !== 1) {
    violated(
      "everyInstructionToARunningAuthorGetsAReceipt",
      `the message posted ${JSON.stringify(stepPosts.map((post) => post.body))}`,
    );
  }
}
