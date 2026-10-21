import type { AgentActivityContent } from "@artfct-ai/adapters/tracker/types";

/** The kind of step a session feed post landed in. */
export type FeedStepKind =
  | "stream"
  | "tick"
  | "turn_start"
  | "turn_end"
  | "stop"
  | "instruction"
  | "restart"
  | "closing_alarm";

/**
 * One activity the tracker stored, under its activity id when it has one. `acknowledged` is false
 * when the orchestrator never saw the tracker take it: a restart cut the post, or the tracker
 * failed after it stored it. `quotaLow` is true when the request quota was low as its step began.
 */
export type FeedPost = {
  id: string | null;
  at: number;
  step: FeedStepKind;
  type: AgentActivityContent["type"];
  body: string;
  ephemeral: boolean;
  acknowledged: boolean;
  quotaLow: boolean;
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

/** The steps that post the narration that waits now: a turn end, a stop, and a closing reply's alarm. */
function postsNarrationNow(post: FeedPost): boolean {
  return post.step === "turn_end" || post.step === "stop" || post.step === "closing_alarm";
}

/**
 * Narration posts at most once per interval. Only the post as a turn ends or stops, or before a
 * closing reply on its alarm, comes sooner. A post the orchestrator never saw land does not start
 * the interval.
 */
export function narrationPostsAtMostOncePerInterval(posts: FeedPost[], intervalMs: number): void {
  let lastAcknowledgedAt: number | null = null;
  for (const post of posts.filter(isNarration)) {
    if (
      !postsNarrationNow(post) &&
      lastAcknowledgedAt !== null &&
      post.at - lastAcknowledgedAt < intervalMs
    ) {
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
 * only after a post that carried it did not land for the orchestrator. Only a line that waited as
 * the feed gave up after its quiet span may never post. A folded closing reply is not such a line.
 */
export function everyNarrationLinePostsInOrder(
  posts: FeedPost[],
  written: string[],
  givenUp: string[],
  folded: FoldedReply[],
): void {
  const foldedBodies = new Set(folded.map((reply) => reply.body));
  const authored = written.filter((line) => !foldedBodies.has(line));
  const posted: string[] = [];
  const unacknowledged = new Set<string>();
  for (const post of posts.filter(isNarration)) {
    for (const line of narrationLines(post).filter((carried) => !foldedBodies.has(carried))) {
      if (!posted.includes(line)) posted.push(line);
      else if (!unacknowledged.has(line)) {
        violated("everyNarrationLinePostsInOrder", `the line ${line} posted twice`);
      }
      if (!post.acknowledged) unacknowledged.add(line);
    }
  }
  const expected = authored.filter((line) => posted.includes(line) || !givenUp.includes(line));
  if (posted.join("|") !== expected.join("|")) {
    violated(
      "everyNarrationLinePostsInOrder",
      `posted ${JSON.stringify(posted)}, written ${JSON.stringify(authored)}`,
    );
  }
}

/**
 * The closing reply of a turn end: its activity id, when its turn ended, the lines before it, and
 * whether its post as the turn ended could land.
 */
export type ClosingTurn = {
  id: string;
  endedAt: number;
  linesBefore: number;
  couldLandAtItsEnd: boolean;
};

/** A closing reply that folded into the narration as its author's next turn started, and when. */
export type FoldedReply = { id: string; body: string; at: number };

/**
 * Every closing reply lands: under its activity id, or as a line of the narration it folded into,
 * unless that narration was given up. Only a reply whose tracker refused its posts, or failed the
 * narration that waits ahead of it, from its turn end until the give-up span after it may be lost.
 * `alarmCouldLandAt` holds each moment a closing reply's alarm fired and its post could land.
 */
export function everyClosingReplyLands(
  posts: FeedPost[],
  closings: ClosingTurn[],
  alarmCouldLandAt: number[],
  givesUpAfterMs: number,
  folds: { folded: FoldedReply[]; givenUp: string[] },
): void {
  for (const closing of closings) {
    if (posts.some((post) => post.id === closing.id)) continue;
    const fold = folds.folded.find((reply) => reply.id === closing.id);
    if (fold) {
      const narrated = posts.some(
        (post) =>
          isNarration(post) && post.at >= fold.at && narrationLines(post).includes(fold.body),
      );
      if (!narrated && !folds.givenUp.includes(fold.body)) {
        violated("everyClosingReplyLands", `the folded reply ${fold.body} never posted`);
      }
      continue;
    }
    const couldLand =
      closing.couldLandAtItsEnd ||
      alarmCouldLandAt.some((at) => at > closing.endedAt && at <= closing.endedAt + givesUpAfterMs);
    if (couldLand) {
      violated(
        "everyClosingReplyLands",
        `the reply of the turn ended at ${closing.endedAt} is lost`,
      );
    }
  }
}

/** The closing reply is the last line of its turn: every line written before it posts first. */
export function theReplyIsTheLastLineOfItsTurn(
  posts: FeedPost[],
  closings: ClosingTurn[],
  written: string[],
): void {
  for (const closing of closings) {
    const replyAt = posts.findIndex((post) => post.id === closing.id);
    if (replyAt < 0) continue;
    const postedBefore = new Set(
      posts.slice(0, replyAt).filter(isNarration).flatMap(narrationLines),
    );
    const late = written.slice(0, closing.linesBefore).find((line) => !postedBefore.has(line));
    if (late) {
      violated("theReplyIsTheLastLineOfItsTurn", `the line ${late} posted after its turn's reply`);
    }
  }
}

/**
 * What one tick or closing reply alarm after a turn did. `activeAt` is the last turn start, turn
 * end, or narration post the orchestrator saw land, and `touchedAt` is the later of it and the
 * last person's message.
 */
export type FeedRetry = {
  at: number;
  stoppedWhileNarrationWaits: boolean;
  trackerCalls: number;
  activeAt: number;
  touchedAt: number;
};

/**
 * After a turn, the feed retries the narration that waits until the feed has been quiet for the
 * give-up span. Then it stops calling the tracker.
 */
export function aQuietFeedStopsRetrying(retry: FeedRetry, givesUpAfterMs: number): void {
  const quietMs = retry.at - retry.activeAt;
  if (retry.stoppedWhileNarrationWaits && quietMs < givesUpAfterMs) {
    violated("aQuietFeedStopsRetrying", `the tick stopped after ${quietMs} ms of quiet`);
  }
  const untouchedMs = retry.at - retry.touchedAt;
  if (retry.trackerCalls > 0 && untouchedMs > givesUpAfterMs) {
    violated("aQuietFeedStopsRetrying", `the tracker was called after ${untouchedMs} ms of quiet`);
  }
}

/**
 * The reply that closes a turn never also posts as narration, unless it folded into the narration
 * as the author's next turn started.
 */
export function theReplyNeverPostsAsNarration(
  posts: FeedPost[],
  replies: string[],
  folded: FoldedReply[],
): void {
  const unfolded = replies.filter((text) => !folded.some((reply) => reply.body === text));
  for (const post of posts.filter(isNarration)) {
    const reply = unfolded.find((text) => narrationLines(post).some((line) => line.includes(text)));
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

/**
 * Heartbeats are the only posts the request quota skips. A turn end posts its closing once, and
 * no narration waits after it, whatever the quota. Receipts are checked with the instruction.
 */
export function heartbeatsAreTheOnlyPostsTheQuotaSkips(
  turnEndPosts: FeedPost[],
  narrationStillWaits: boolean,
): void {
  const closings = turnEndPosts.filter((post) => post.type === "response" || post.type === "error");
  if (closings.length !== 1) {
    violated(
      "heartbeatsAreTheOnlyPostsTheQuotaSkips",
      `the turn end posted ${closings.length} closings`,
    );
  }
  if (narrationStillWaits) {
    violated("heartbeatsAreTheOnlyPostsTheQuotaSkips", "narration still waits after the turn end");
  }
}

/**
 * While the quota is low, a heartbeat does not post, and narration waits for the turn end or a
 * closing reply's alarm. It then posts merged with the lines after it.
 */
export function heartbeatsAndNarrationWaitWhileTheQuotaIsLow(posts: FeedPost[]): void {
  for (const post of posts.filter((posted) => posted.quotaLow)) {
    if (post.ephemeral && post.step === "tick") {
      violated("heartbeatsAndNarrationWaitWhileTheQuotaIsLow", `a heartbeat posted: ${post.body}`);
    }
    if (isNarration(post) && !postsNarrationNow(post)) {
      violated(
        "heartbeatsAndNarrationWaitWhileTheQuotaIsLow",
        `narration posted on a ${post.step} step: ${post.body}`,
      );
    }
  }
}

/** What one person's message in the job session did. */
export type InstructionOutcome = {
  /** The workflow had not ended when the message arrived. */
  workflowRuns: boolean;
  /** The session's author was in a turn when the message arrived. */
  authorInTurn: boolean;
  /** The message is in the author's prompt queue. */
  reachedTheAuthor: boolean;
  /** The agent got the message with a wake, so its turn answers the person. */
  wokeTheAgent: boolean;
  /** What the tracker stored as the message arrived. */
  posts: FeedPost[];
};

/**
 * A person's message to a running workflow gets one receipt, an ephemeral thought. It reaches
 * the author in its turn as a prompt, or else wakes the agent, whose turn answers. A message to a
 * finished workflow gets the reply that it ended instead.
 */
export function everyInstructionGetsAReceipt(
  outcome: InstructionOutcome,
  receiptText: string,
): void {
  const receipts = outcome.posts.filter(
    (post) => post.type === "thought" && post.ephemeral && post.body === receiptText,
  );
  if (!outcome.workflowRuns) {
    const replies = outcome.posts.filter((post) => post.type === "response");
    if (receipts.length > 0 || replies.length !== 1) {
      violated(
        "everyInstructionGetsAReceipt",
        `a finished workflow posted ${JSON.stringify(outcome.posts.map((post) => post.body))}`,
      );
    }
    return;
  }
  if (receipts.length !== 1 || outcome.posts.length !== 1) {
    violated(
      "everyInstructionGetsAReceipt",
      `the message posted ${JSON.stringify(outcome.posts.map((post) => post.body))}`,
    );
  }
  if (outcome.authorInTurn && (!outcome.reachedTheAuthor || outcome.wokeTheAgent)) {
    violated("everyInstructionGetsAReceipt", "the message did not reach the author in its turn");
  }
  if (!outcome.authorInTurn && !outcome.wokeTheAgent) {
    violated("everyInstructionGetsAReceipt", "the message did not wake the agent");
  }
}
