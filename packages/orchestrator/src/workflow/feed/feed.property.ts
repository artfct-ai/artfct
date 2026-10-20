import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import type { AgentActivityContent, RequestQuota } from "@artfct-ai/adapters/tracker/types";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { FakeRuntime, seedTask } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import {
  aQuietTurnGetsAHeartbeat,
  aToolCallNeverPosts,
  everyInstructionGetsAReceipt,
  everyNarrationLinePostsInOrder,
  heartbeatsAndNarrationWaitWhileTheQuotaIsLow,
  heartbeatsAreTheOnlyPostsTheQuotaSkips,
  narrationPostsAtMostOncePerInterval,
  theReplyNeverPostsAsNarration,
  type FeedPost,
  type FeedStepKind,
} from "../../../test/session-feed-invariants";
import { testNotifier } from "../../../test/notifier-fixture";
import { SessionTracker, type TrackerHealth } from "../../../test/session-tracker";
import { testEnv } from "../../../test/test-env";
import { handleEvent } from "../inbound/events";
import {
  HEARTBEAT_AFTER_MS,
  NARRATION_INTERVAL_MS,
  RECEIPT_TEXT,
  STOPPED_CLOSING,
  closeSessionFeed,
  closingWhenTheAuthorGoesOn,
  feedClosingOf,
  startSessionFeedTurn,
  streamToSessionFeed,
  tendSessionFeed,
} from "./feed";

const RUNS = 300;

const SESSION = { source: "tracker", session_id: "s-start", issue_id: "ENG-1" } as const;
const AUTHOR = "wf_x.1";
const TURN_START = Date.parse("2026-10-20T12:00:00.000Z");
const MINUTE_MS = 60_000;
const QUOTA_LIMIT = 5000;
const FINAL_TICKS = 90;

type FeedAction =
  | { kind: "say" }
  | { kind: "think" }
  | { kind: "tool"; titled: boolean; status: "completed" | "failed" }
  | { kind: "narrate"; steps: number }
  | { kind: "wait"; minutes: number }
  | { kind: "quota"; low: boolean }
  | { kind: "health"; health: TrackerHealth }
  | { kind: "instruction" }
  | { kind: "turn_end"; reason: StopReason }
  | { kind: "turn_end_going_on"; reason: StopReason }
  | { kind: "stop" }
  | { kind: "author_finishes" }
  | { kind: "workflow_ends" }
  | { kind: "turn_start" }
  | { kind: "restart" }
  | { kind: "restart_mid_narration"; stored: boolean };

const feedAction: fc.Arbitrary<FeedAction> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: "say" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "think" as const }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("tool" as const),
      titled: fc.boolean(),
      status: fc.constantFrom("completed" as const, "failed" as const),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("narrate" as const),
      steps: fc.integer({ min: 2, max: 4 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("wait" as const),
      minutes: fc.integer({ min: 1, max: 30 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("quota" as const), low: fc.boolean() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("health" as const),
      health: fc.constantFrom<TrackerHealth>(
        "up",
        "up",
        "fails_before_storing",
        "fails_after_storing",
      ),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "instruction" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("turn_end" as const),
      reason: fc.constantFrom<StopReason>("end_turn", "end_turn", "cancelled", "max_tokens"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("turn_end_going_on" as const),
      reason: fc.constantFrom<StopReason>("end_turn", "end_turn", "cancelled", "max_tokens"),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "stop" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "author_finishes" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "workflow_ends" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "turn_start" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "restart" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("restart_mid_narration" as const),
      stored: fc.boolean(),
    }),
  },
);

const NARRATION_OF_A_FAILED_TURN_END_BEFORE_THE_AUTHOR_FINISHES: FeedAction[] = [
  { kind: "health", health: "fails_before_storing" },
  { kind: "narrate", steps: 2 },
  { kind: "turn_end", reason: "end_turn" },
  { kind: "health", health: "up" },
  { kind: "author_finishes" },
  { kind: "health", health: "up" },
];

type Witnesses = {
  narrationMerged: number;
  dueNarrationWhileQuotaLow: number;
  turnEndsWithWaitingNarrationWhileQuotaLow: number;
  heartbeats: number;
  receiptsInATurn: number;
  receiptsBetweenTurns: number;
  receiptsAfterTheAuthorFinished: number;
  repliesOfAnEndedWorkflow: number;
  repostedAfterARestart: number;
  narrationPostedAfterTheTurn: number;
  accountsNarrated: number;
};

/** A session feed under test: the runtime, the tracker, and what the property expects of them. */
function restartSignal(): { wasCut: Promise<"cut">; cut: () => void } {
  let resolveCut: ((value: "cut") => void) | null = null;
  const wasCut = new Promise<"cut">((resolve) => {
    resolveCut = resolve;
  });
  return { wasCut, cut: () => resolveCut?.("cut") };
}

class FeedRun {
  workflow: FakeRuntime;
  readonly tracker = new SessionTracker();
  readonly posts: FeedPost[] = [];
  readonly written: string[] = [];
  readonly replies: string[] = [];
  readonly toolTitles: string[] = [];
  private message = "";
  private inFlight = true;
  private authorFinished = false;
  private workflowEnded = false;
  private quietSince = TURN_START;
  private lineCount = 0;
  private toolCount = 0;
  private instructionCount = 0;

  constructor(private readonly witnesses: Witnesses) {
    this.workflow = new FakeRuntime(openMemoryDb(), testEnv());
    this.workflow.store.updateWorkflow({ origin: SESSION });
    this.workflow.store.addReplyTarget(SESSION);
    this.workflow.notifier = testNotifier([], { tracker: this.tracker });
    this.workflow.trackerInstance = this.tracker;
    this.workflow.clock = TURN_START;
    seedTask(this.workflow, { issue_id: "ENG-1" }, { session_id: "acp-1", prompt_in_flight: 1 });
  }

  async start(): Promise<void> {
    await startSessionFeedTurn(this.workflow, this.author());
  }

  private author() {
    return this.workflow.store.requireTask(AUTHOR);
  }

  private now(): number {
    return this.workflow.now();
  }

  private quotaLow(): boolean {
    const quota = this.tracker.quota;
    return quota !== null && this.now() < quota.resets_at && quota.remaining * 10 < quota.limit;
  }

  private takesPosts(): boolean {
    return this.tracker.health !== "fails_before_storing";
  }

  private async stream(update: SessionUpdate): Promise<void> {
    await streamToSessionFeed(this.workflow, this.author(), update);
  }

  private async record(step: FeedStepKind, run: () => Promise<unknown>): Promise<FeedPost[]> {
    const before = this.tracker.stored.length;
    const acknowledged = this.tracker.health === "up";
    const quotaLow = this.quotaLow();
    await run();
    const landed = this.tracker.stored.slice(before).map((stored) =>
      feedPostOf(stored.content, stored.ephemeral, {
        at: this.now(),
        step,
        acknowledged,
        quotaLow,
      }),
    );
    this.posts.push(...landed);
    if (landed.length > 0) this.quietSince = this.now();
    return landed;
  }

  private writeLine(): void {
    const line = this.message.trim();
    this.message = "";
    if (!line) return;
    const waiting = this.workflow.store.sessionFeed(AUTHOR)?.narration;
    if (waiting) this.witnesses.narrationMerged += 1;
    this.written.push(line);
  }

  private async toolCall(titled: boolean, status: "completed" | "failed"): Promise<void> {
    this.toolCount += 1;
    const toolCallId = `call-${this.toolCount}`;
    const title = titled ? `tool-title-${this.toolCount}` : "";
    if (titled) this.toolTitles.push(title);
    this.writeLine();
    await this.stream({ sessionUpdate: "tool_call", toolCallId, title, kind: "edit" });
    await this.stream({ sessionUpdate: "tool_call_update", toolCallId, status });
  }

  private async tick(): Promise<void> {
    this.workflow.clock = this.now() + MINUTE_MS;
    this.passQuotaReset();
    const lowBefore = this.quotaLow();
    const waiting = this.workflow.store.sessionFeed(AUTHOR);
    const narrationDue =
      !!waiting?.narration &&
      (waiting.narrated_at === null ||
        this.now() - Date.parse(waiting.narrated_at) >= NARRATION_INTERVAL_MS);
    if (narrationDue && lowBefore && this.inFlight) this.witnesses.dueNarrationWhileQuotaLow += 1;
    const tickPosts = await this.record("tick", () =>
      tendSessionFeed(this.workflow, { task_id: AUTHOR }),
    );
    this.witnesses.heartbeats += tickPosts.filter((post) => post.ephemeral).length;
    if (!this.inFlight && tickPosts.some((post) => !post.ephemeral))
      this.witnesses.narrationPostedAfterTheTurn += 1;
    if (!this.inFlight || this.tracker.health !== "up") return;
    if (!lowBefore) aQuietTurnGetsAHeartbeat(this.now(), this.quietSince, HEARTBEAT_AFTER_MS);
  }

  private async endTurn(reason: StopReason | "stop"): Promise<void> {
    if (!this.inFlight) return;
    this.inFlight = false;
    this.workflow.store.updateSandbox(AUTHOR, { prompt_in_flight: 0 });
    this.workflow.store.updateTask(AUTHOR, { status: "in_review" });
    const reply = this.message.trim();
    this.message = "";
    if (reason === "end_turn" && reply) this.replies.push(reply);
    const closing = reason === "stop" ? STOPPED_CLOSING : feedClosingOf(reason);
    const narrationWaits = !!this.workflow.store.sessionFeed(AUTHOR)?.narration;
    if (narrationWaits && this.quotaLow())
      this.witnesses.turnEndsWithWaitingNarrationWhileQuotaLow += 1;
    const posts = await this.record(reason === "stop" ? "stop" : "turn_end", () =>
      closeSessionFeed(this.workflow, this.author(), closing),
    );
    if (this.tracker.health !== "up") return;
    const stillWaits = !!this.workflow.store.sessionFeed(AUTHOR)?.narration;
    heartbeatsAreTheOnlyPostsTheQuotaSkips(posts, stillWaits);
  }

  /**
   * The turn ends while a prompt waits, so the author goes straight into its next turn. The
   * account of a turn that ended on its own is a narration line.
   */
  private async endTurnGoingOn(reason: StopReason): Promise<void> {
    if (!this.inFlight) return;
    const account = this.message.trim();
    this.message = "";
    if (reason === "end_turn" && account) {
      this.written.push(account);
      this.witnesses.accountsNarrated += 1;
    }
    const closing = closingWhenTheAuthorGoesOn(feedClosingOf(reason));
    await this.record("turn_end", () => closeSessionFeed(this.workflow, this.author(), closing));
    this.quietSince = this.now();
    await this.record("turn_start", () => startSessionFeedTurn(this.workflow, this.author()));
  }

  /** The author finishes at a turn end the tracker takes, so no narration waits after it. */
  private async finishAuthor(): Promise<void> {
    if (this.authorFinished || this.tracker.health !== "up") return;
    await this.endTurn("end_turn");
    this.authorFinished = true;
    this.workflow.store.updateTask(AUTHOR, { status: "done" });
  }

  /** The workflow ends, and its author's turn stops, while the tracker takes posts. */
  private async endWorkflow(): Promise<void> {
    if (this.workflowEnded || this.tracker.health !== "up") return;
    await this.endTurn("stop");
    this.authorFinished = true;
    this.workflowEnded = true;
    this.workflow.store.updateTask(AUTHOR, { status: "cancelled" });
    this.workflow.store.updateWorkflow({ status: "done" });
  }

  private async startTurn(): Promise<void> {
    if (this.inFlight || this.authorFinished) return;
    this.inFlight = true;
    this.workflow.store.updateSandbox(AUTHOR, { prompt_in_flight: 1 });
    this.workflow.store.updateTask(AUTHOR, { status: "working" });
    const queued = this.workflow.store.peekPrompt(AUTHOR);
    if (queued) this.workflow.store.dequeuePrompt(queued.id);
    this.quietSince = this.now();
    await this.record("turn_start", () => startSessionFeedTurn(this.workflow, this.author()));
  }

  private async instruct(): Promise<void> {
    this.instructionCount += 1;
    const text = `instruction-${this.instructionCount}`;
    const notesBefore = this.workflow.notes.length;
    const posts = await this.record("instruction", () =>
      handleEvent(this.workflow, instructionEvent(text)),
    );
    if (this.tracker.health !== "up") return;
    this.countInstruction();
    everyInstructionGetsAReceipt(
      {
        workflowRuns: !this.workflowEnded,
        authorInTurn: this.inFlight,
        reachedTheAuthor: this.workflow.store.queue().some((row) => row.text === text),
        wokeTheAgent: this.workflow.notes
          .slice(notesBefore)
          .some((note) => note.wake === "message"),
        posts,
      },
      RECEIPT_TEXT,
    );
  }

  private countInstruction(): void {
    if (this.workflowEnded) this.witnesses.repliesOfAnEndedWorkflow += 1;
    else if (this.authorFinished) this.witnesses.receiptsAfterTheAuthorFinished += 1;
    else if (this.inFlight) this.witnesses.receiptsInATurn += 1;
    else this.witnesses.receiptsBetweenTurns += 1;
  }

  private restart(): void {
    this.workflow = this.workflow.restarted();
    this.message = "";
  }

  private async restartMidNarration(stored: boolean): Promise<void> {
    if (!this.inFlight) return;
    const { wasCut, cut } = restartSignal();
    this.tracker.cutNextActivity({ types: ["thought"], stored, cut });
    this.lineCount += 1;
    this.message += `[line-${this.lineCount}]`;
    await this.stream(say(`[line-${this.lineCount}]`));
    const before = this.tracker.stored.length;
    const quotaLow = this.quotaLow();
    const toolCall = this.toolCall(true, "completed").then(() => "ended" as const);
    const outcome = await Promise.race([wasCut, toolCall]);
    this.tracker.cutNextActivity({ types: [], stored: false, cut: () => {} });
    const landed = this.tracker.stored.slice(before).map((activity) =>
      feedPostOf(activity.content, activity.ephemeral, {
        at: this.now(),
        step: "stream",
        acknowledged: outcome !== "cut" && this.tracker.health === "up",
        quotaLow,
      }),
    );
    this.posts.push(...landed);
    if (landed.length > 0) this.quietSince = this.now();
    if (outcome !== "cut") return;
    if (stored) this.witnesses.repostedAfterARestart += 1;
    this.restart();
  }

  async take(action: FeedAction): Promise<void> {
    switch (action.kind) {
      case "say":
        if (!this.inFlight) return;
        this.lineCount += 1;
        this.message += `[line-${this.lineCount}]`;
        await this.stream(say(`[line-${this.lineCount}]`));
        return;
      case "think":
        if (!this.inFlight) return;
        await this.stream({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "[thinking]" },
        });
        return;
      case "tool":
        if (!this.inFlight) return;
        await this.record("stream", () => this.toolCall(action.titled, action.status));
        return;
      case "narrate":
        for (let step = 0; step < action.steps; step += 1) {
          await this.take({ kind: "say" });
          await this.take({ kind: "tool", titled: step % 2 === 0, status: "completed" });
        }
        return;
      case "wait":
        for (let minute = 0; minute < action.minutes; minute += 1) await this.tick();
        return;
      case "quota":
        this.setQuota(action.low);
        return;
      case "health":
        if (this.tracker.health !== "up" && action.health === "up") this.quietSince = this.now();
        this.tracker.health = action.health;
        return;
      case "instruction":
        return this.instruct();
      case "turn_end":
        return this.endTurn(action.reason);
      case "turn_end_going_on":
        return this.endTurnGoingOn(action.reason);
      case "stop":
        return this.endTurn("stop");
      case "author_finishes":
        return this.finishAuthor();
      case "workflow_ends":
        return this.endWorkflow();
      case "turn_start":
        return this.startTurn();
      case "restart":
        this.restart();
        return;
      case "restart_mid_narration":
        return this.restartMidNarration(action.stored);
      default: {
        const unhandled: never = action;
        throw new Error(`unhandled feed action ${JSON.stringify(unhandled)}`);
      }
    }
  }

  private setQuota(low: boolean): void {
    if (this.quotaLow() && !low) this.quietSince = this.now();
    const quota: RequestQuota = {
      remaining: low ? QUOTA_LIMIT / 20 : QUOTA_LIMIT / 2,
      limit: QUOTA_LIMIT,
      resets_at: this.now() + 60 * MINUTE_MS,
    };
    this.tracker.quota = quota;
  }

  /** The quota's reset counts as the moment posts became possible again. */
  private passQuotaReset(): void {
    const quota = this.tracker.quota;
    if (quota && this.now() >= quota.resets_at)
      this.quietSince = Math.max(this.quietSince, quota.resets_at);
  }

  /** End the run with the tracker up, so every narration line that waits posts. */
  async finish(): Promise<void> {
    this.tracker.health = "up";
    await this.startTurn();
    await this.endTurn("end_turn");
    for (let tick = 0; tick < FINAL_TICKS && this.feedTicks(); tick += 1) await this.tick();
  }

  private feedTicks(): boolean {
    return this.workflow.alarmsFor("tendSessionFeed").length > 0;
  }
}

function say(text: string): SessionUpdate {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

function instructionEvent(text: string): InboundEvent {
  return {
    id: `evt-${text}`,
    kind: "prompt",
    actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
    bindings: [],
    links: [],
    text,
    reply_to: SESSION,
  };
}

function bodyOf(content: AgentActivityContent): string {
  switch (content.type) {
    case "action":
      return `${content.action} ${content.parameter}`;
    default:
      return content.body;
  }
}

function feedPostOf(
  content: AgentActivityContent,
  ephemeral: boolean,
  landing: Pick<FeedPost, "at" | "step" | "acknowledged" | "quotaLow">,
): FeedPost {
  return { ...landing, type: content.type, body: bodyOf(content), ephemeral };
}

describe("session feed invariants", () => {
  it(
    "hold on any sequence of author updates, ticks, instructions, failures, and restarts",
    async () => {
      const witnesses: Witnesses = {
        narrationMerged: 0,
        dueNarrationWhileQuotaLow: 0,
        turnEndsWithWaitingNarrationWhileQuotaLow: 0,
        heartbeats: 0,
        receiptsInATurn: 0,
        receiptsBetweenTurns: 0,
        receiptsAfterTheAuthorFinished: 0,
        repliesOfAnEndedWorkflow: 0,
        repostedAfterARestart: 0,
        narrationPostedAfterTheTurn: 0,
        accountsNarrated: 0,
      };
      await fc.assert(
        fc.asyncProperty(fc.array(feedAction, { minLength: 1, maxLength: 60 }), async (actions) => {
          const run = new FeedRun(witnesses);
          await run.start();
          for (const action of actions) await run.take(action);
          await run.finish();
          aToolCallNeverPosts(run.posts, run.toolTitles);
          narrationPostsAtMostOncePerInterval(run.posts, NARRATION_INTERVAL_MS);
          theReplyNeverPostsAsNarration(run.posts, run.replies);
          everyNarrationLinePostsInOrder(run.posts, run.written);
          heartbeatsAndNarrationWaitWhileTheQuotaIsLow(run.posts);
        }),
        {
          ...propertyRuns("session feed invariants", RUNS),
          examples: [[NARRATION_OF_A_FAILED_TURN_END_BEFORE_THE_AUTHOR_FINISHES]],
        },
      );
      expect(witnesses.narrationMerged).toBeGreaterThan(0);
      expect(witnesses.dueNarrationWhileQuotaLow).toBeGreaterThan(0);
      expect(witnesses.heartbeats).toBeGreaterThan(0);
      expect(witnesses.turnEndsWithWaitingNarrationWhileQuotaLow).toBeGreaterThan(0);
      expect(witnesses.receiptsInATurn).toBeGreaterThan(0);
      expect(witnesses.receiptsBetweenTurns).toBeGreaterThan(0);
      expect(witnesses.receiptsAfterTheAuthorFinished).toBeGreaterThan(0);
      expect(witnesses.repliesOfAnEndedWorkflow).toBeGreaterThan(0);
      expect(witnesses.repostedAfterARestart).toBeGreaterThan(0);
      expect(witnesses.narrationPostedAfterTheTurn).toBeGreaterThan(0);
      expect(witnesses.accountsNarrated).toBeGreaterThan(0);
    },
    propertyTimeoutMs(30_000, RUNS),
  );
});
