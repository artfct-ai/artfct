import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { VendorEvent } from "@artfct-ai/contracts/types";
import { setSystemTime } from "bun:test";
import { loadWorkflowDefinition } from "../src/config/workflow-definition";
import { createDb, type Database } from "../src/db/client";
import { conversationIdOf, conversationRecorded } from "../src/db/conversations";
import { recordedFiringThread } from "../src/db/firing-threads";
import { fireMatchingTriggers } from "../src/router/vendor-event";
import { firingKey } from "../src/triggers/firing-key";
import { consumeFiringMessage } from "../src/triggers/firing-queue";
import { scheduledFirings } from "../src/triggers/schedule";
import type { ConversationFiring, FiringAnswer, TriggerFiring } from "../src/triggers/types";
import { handleEvent } from "../src/workflow/inbound/events";
import { fireWorkflow } from "../src/workflow/inbound/firing";
import { resumeWorkflowEnd } from "../src/workflow/lifecycle";
import { Deferred } from "./deferred";
import { FakeRuntime } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfSet, itfText, itfVariant } from "./itf";
import { openMemoryDb, storeRowsOf, type MemoryDb } from "./memory-db";
import { quintTraces } from "./quint-traces";
import { runStartStep, startRestartedInstance } from "./restart";
import { sqliteD1 } from "./sqlite-d1";
import { TEST_CONFIG, TEST_DEFINITION_NAME } from "./test-config";
import { testEnv } from "./test-env";

/** The setup modules of the trigger firings spec. */
export const SPEC_SETUPS = ["twoMinutes", "pullRequestEvents", "aMinuteAndAChannelEvent"] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/**
 * The scheduled firings and the channel event firings of each setup, in that order. The firings
 * after them are pull request firings.
 */
const SETUP_FIRINGS: Record<SpecSetup, { scheduled: number; channelEvents: number }> = {
  twoMinutes: { scheduled: 2, channelEvents: 0 },
  pullRequestEvents: { scheduled: 0, channelEvents: 0 },
  aMinuteAndAChannelEvent: { scheduled: 1, channelEvents: 1 },
};

/** The one pull request every pull request firing names. */
const PULL_REQUEST = { repo: "acme/app", number: 12 };

const PULL_REQUEST_EVENT = "github.pull_request.synchronize";

const CHANNEL_EVENT = "github.release.published";

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 40;

const CHANNEL = "C1";

/** The minute the spec's first firing is scheduled for. Firing `f` is `f` minutes later. */
const FIRST_MINUTE_MS = Date.UTC(2026, 9, 19, 9, 0);

const MINUTE_MS = 60_000;

/** How long after its minute a scheduled run starts, on time and late. */
const ON_TIME_MS = 5_000;
const LATE_MS = 90_000;

/** The thread of the start line the chat posts `line`th, counted from 0. */
const FIRST_LINE_SECONDS = 1_800_000_000;

/** The test workflow definition with a trigger every minute, one on a pull request event, and one on a channel event. */
const DEFINITION = loadWorkflowDefinition(
  TEST_DEFINITION_NAME,
  [
    TEST_CONFIG.workflowDefinitions[0]!.text,
    "triggers:",
    `  - { schedule: "* * * * *", channel: ${CHANNEL}, prompt: Upgrade the dependencies. }`,
    `  - { event: ${PULL_REQUEST_EVENT}, prompt: Review the change. }`,
    `  - { event: ${CHANNEL_EVENT}, channel: ${CHANNEL}, prompt: Write the release notes. }`,
  ].join("\n"),
);

/** The conversation of the pull request and the definition. */
const PULL_REQUEST_PLACE = {
  source: "pull_request",
  ...PULL_REQUEST,
  definition: DEFINITION.name,
} as const;

/** One attempt in the queue, as the spec sees it. */
type MessageView = { firing: number; attempt: number; delay: number; acked: boolean };

/** One queue delivery, as the spec sees it, with its phase written as the spec's variant. */
type DeliveryView = { message: number; phase: string };

/** A firing's prompt that reached a workflow of the pull request's conversation. */
type PromptView = { firing: number; workflow: number };

/** The queue, the chat, D1 and the conversations, as the spec sees them. */
export type FiringsView = {
  messages: MessageView[];
  deliveries: DeliveryView[];
  startLines: number[];
  records: [number, number][];
  recordedConversations: number[];
  startedConversations: number[];
  failureLines: [number, number][];
  pullWorkflows: string[];
  pullSeen: number[];
  pullPrompts: PromptView[];
  failureComments: number;
};

/** What a spec action picked. */
type SpecPicks = {
  firing: number | null;
  late: boolean | null;
  id: number | null;
  delivery: number | null;
  posted: boolean | null;
  sent: boolean | null;
  landed: boolean | null;
};

/** One state of a trace: the action that led to it, what it picked, and the spec's view. */
export type TraceStep = { action: string; picks: SpecPicks; view: FiringsView };

/** Run the spec of one setup for `count` traces from `seed`. */
export function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces({ spec: "trigger-firings", setup, count, steps: TRACE_STEPS, seed }, (trace) =>
    traceSteps(trace),
  );
}

function traceSteps(trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const worldName = Object.keys(asRecord(state)).find((name) => name.endsWith("::world"));
    if (!worldName) throw new Error("the trace has no world");
    const picks = itfField(state, "mbt::nondetPicks");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        firing: pickedInt(picks, "firing"),
        late: pickedBool(picks, "late"),
        id: pickedInt(picks, "id"),
        delivery: pickedInt(picks, "delivery"),
        posted: pickedBool(picks, "posted"),
        sent: pickedBool(picks, "sent"),
        landed: pickedBool(picks, "landed"),
      },
      view: specView(itfField(state, worldName)),
    };
  });
}

function pickedValue(picks: unknown, name: string): unknown {
  const picked = itfVariant(itfField(picks, name, true));
  return picked?.tag === "Some" ? picked.value : null;
}

function pickedInt(picks: unknown, name: string): number | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfInt(value);
}

function pickedBool(picks: unknown, name: string): boolean | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfBool(value);
}

function itfMapEntries(value: unknown): [number, unknown][] {
  return itfList(itfField(value, "#map"))
    .map((pair): [number, unknown] => {
      const [key, entry] = itfList(pair);
      return [itfInt(key), entry];
    })
    .toSorted(([left], [right]) => left - right);
}

function itfIntSet(value: unknown): number[] {
  return itfSet(value)
    .map(itfInt)
    .toSorted((left, right) => left - right);
}

/** A spec variant written as Quint writes it, such as `Finished(GaveUp(InThread(1)))`. */
function variantText(value: unknown): string {
  const variant = itfVariant(value)!;
  const inner = variant.value;
  if (typeof inner === "object" && inner !== null && "#tup" in inner) return variant.tag;
  if (typeof inner === "object" && inner !== null && "#bigint" in inner)
    return `${variant.tag}(${itfInt(inner)})`;
  return `${variant.tag}(${variantText(inner)})`;
}

function specView(world: unknown): FiringsView {
  return {
    messages: itfMapEntries(itfField(world, "messages")).map(([, message]) => ({
      firing: itfInt(itfField(message, "firing")),
      attempt: itfInt(itfField(message, "attempt")),
      delay: itfInt(itfField(message, "delay")),
      acked: itfBool(itfField(message, "acked")),
    })),
    deliveries: itfMapEntries(itfField(world, "deliveries")).map(([, delivery]) => ({
      message: itfInt(itfField(delivery, "message")),
      phase: variantText(itfField(delivery, "phase")),
    })),
    startLines: itfMapEntries(itfField(world, "startLines")).map(([, firing]) => itfInt(firing)),
    records: itfMapEntries(itfField(world, "records")).map(([firing, thread]) => [
      firing,
      itfInt(thread),
    ]),
    recordedConversations: itfIntSet(itfField(world, "recordedConversations")),
    startedConversations: itfIntSet(itfField(world, "startedConversations")),
    failureLines: itfMapEntries(itfField(world, "failureLines")).map(([thread, count]) => [
      thread,
      itfInt(count),
    ]),
    pullWorkflows: itfList(itfField(world, "pullWorkflows")).map(variantText),
    pullSeen: itfIntSet(itfField(world, "pullSeen")),
    pullPrompts: itfList(itfField(world, "pullPrompts")).map((prompt) => ({
      firing: itfInt(itfField(prompt, "firing")),
      workflow: itfInt(itfField(prompt, "workflow")),
    })),
    failureComments: itfInt(itfField(world, "failureComments")),
  };
}

function asRecord(value: unknown): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the trace has ${JSON.stringify(value)}, not a record`);
  }
  return value;
}

/** Where a delivery calls its conversation, written as the spec's variant. */
type PlaceText = `InThread(${number})` | "OnThePullRequest";

/** What a failure line post or a failure comment returns. Each caller reads its own field. */
type FailureLineAnswer = { ts: string; id: number };

/** A call the consumer of one delivery waits on until the spec answers it. */
type HeldCall =
  | { kind: "post"; answer: Deferred<{ ts: string }> }
  | {
      kind: "fire";
      place: PlaceText;
      conversationId: string;
      firing: ConversationFiring;
      answer: Deferred<FiringAnswer>;
      handler: Promise<FiringAnswer> | null;
      tell: Deferred<void> | null;
    }
  | { kind: "send"; firing: TriggerFiring; delaySeconds: number; answer: Deferred<void> }
  | { kind: "failureLine"; place: PlaceText; answer: Deferred<FailureLineAnswer> };

/** One run of the real consumer on one queue message. */
type ReplayDelivery = {
  message: number;
  held: HeldCall | null;
  settled: boolean;
  died: boolean;
  retried: boolean;
  sent: boolean;
  taken: boolean;
  failureLinePlace: PlaceText | null;
};

/** One attempt in the fake queue. */
type QueuedMessage = { body: TriggerFiring; delay: number; acked: boolean };

/** A prompt the conversation queued for its agent: the firing it names and its workflow. */
type ToldPrompt = { firing: number; workflowId: string };

/**
 * One conversation, by its id: its runtime and store, the agent tells it holds until the spec
 * answers them, the prompts it queued, and the end posts it holds.
 */
type ReplayConversation = {
  runtime: FakeRuntime;
  store: MemoryDb;
  tells: Deferred<void>[];
  prompts: ToldPrompt[];
  endPosts: Deferred<void>[];
};

/** A code host whose pull request comments wait for the spec. */
class DeliveryCodeHost extends FakeCodeHost {
  constructor(private readonly comment: () => Promise<{ id: number }>) {
    super();
  }

  override commentOnPull(): Promise<{ id: number }> {
    return this.comment();
  }
}

/** The calls the chat of one delivery hands to the replay. */
type DeliveryChatCalls = {
  post: () => Promise<{ ts: string }>;
  reply: (replyThread: string) => Promise<{ ts: string }>;
};

/** A chat whose start line and failure line posts wait for the spec. */
class DeliveryChat extends FakeChat {
  constructor(private readonly held: DeliveryChatCalls) {
    super();
  }

  override postChannelMessage(): Promise<{ ts: string }> {
    return this.held.post();
  }

  override postThreadReply(_channel: string, replyThread: string): Promise<{ ts: string }> {
    return this.held.reply(replyThread);
  }
}

/**
 * Replays spec traces through the scheduled run, the real firing queue consumer, D1 and the real
 * conversation handler. Each chat post, conversation call and queue send waits until a spec step
 * answers it.
 */
export class TriggerFiringsReplay {
  constructor(private readonly setup: SpecSetup) {}

  private readonly d1 = sqliteD1();
  private readonly db: Database = createDb(this.d1);
  private readonly messages: QueuedMessage[] = [];
  private readonly deliveries: ReplayDelivery[] = [];
  private readonly startLines: number[] = [];
  private readonly failureLineCalls = new Map<number, number>();
  private readonly conversations = new Map<string, ReplayConversation>();
  private failureComments = 0;
  private closes = 0;

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "theScheduledRunQueues":
        this.runScheduledMinute(required(picks.firing, "firing"), required(picks.late, "late"));
        return;
      case "aChannelEventFires":
        await this.fireVendorEvent(vendorEventOf(required(picks.firing, "firing"), CHANNEL_EVENT));
        return;
      case "aPullRequestEventFires":
        await this.fireThePullRequestEvent(required(picks.firing, "firing"));
        return;
      case "theQueueDelivers":
        await this.deliver(required(picks.id, "id"));
        return;
      case "theStartLinePostReturns":
        await this.answerStartLine(
          required(picks.delivery, "delivery"),
          required(picks.posted, "posted"),
        );
        return;
      case "theConversationTakesTheFiring":
        await this.takeTheFiring(required(picks.delivery, "delivery"));
        return;
      case "theConversationAnswers":
        await this.answerTheFiring(required(picks.delivery, "delivery"));
        return;
      case "theConversationCallFails":
        await this.failTheCall(required(picks.delivery, "delivery"));
        return;
      case "theConversationRestarts":
        await this.restartTheConversation(required(picks.delivery, "delivery"));
        return;
      case "thePullRequestConversationRestarts":
        await this.restartThePullRequestConversation();
        return;
      case "theWatcherEndStarts":
        await this.closeThePullRequest();
        return;
      case "theWatcherEndFinishes":
        await this.finishTheWatcherEnd();
        return;
      case "theNextAttemptIsSent":
        await this.answerTheSend(
          required(picks.delivery, "delivery"),
          required(picks.sent, "sent"),
        );
        return;
      case "theFailureLinePostReturns":
        await this.answerTheFailureLine(
          required(picks.delivery, "delivery"),
          required(picks.posted, "posted"),
        );
        return;
      case "aConsumerDies":
        this.killTheConsumer(
          required(picks.delivery, "delivery"),
          required(picks.landed, "landed"),
        );
        return;
      case "finished":
        return;
      default:
        throw new Error(`no replay for spec action ${step.action}`);
    }
  }

  /** The queue, the chat, D1 and the conversations as the spec sees them. */
  async project(): Promise<FiringsView> {
    const threads = this.startLines.map((_, thread) => thread);
    const firings = [...new Set(this.messages.map((message) => firingOf(message.body)))].toSorted(
      (left, right) => left - right,
    );
    const records: [number, number][] = [];
    for (const firing of firings.filter((fired) => !this.isPullFiring(fired))) {
      const recorded = await recordedFiringThread(this.db, this.firingBody(firing));
      if (recorded) records.push([firing, threadOf(recorded.thread)]);
    }
    const recordedConversations: number[] = [];
    const startedConversations: number[] = [];
    for (const thread of threads) {
      if (await conversationRecorded(this.db, placeOf(thread))) recordedConversations.push(thread);
      const conversation = this.conversations.get(await conversationIdOf(placeOf(thread)));
      if (conversation && this.startedIn(conversation, thread)) startedConversations.push(thread);
    }
    return {
      messages: this.messages.map((message) => ({
        firing: firingOf(message.body),
        attempt: message.body.attempt,
        delay: message.delay,
        acked: message.acked,
      })),
      deliveries: this.deliveries.map((delivery) => ({
        message: delivery.message,
        phase: phaseText(delivery),
      })),
      startLines: [...this.startLines],
      records,
      recordedConversations,
      startedConversations,
      failureLines: [...this.failureLineCalls.entries()].toSorted(
        ([left], [right]) => left - right,
      ),
      ...(await this.pullRequestView(firings.filter((fired) => this.isPullFiring(fired)))),
      failureComments: this.failureComments,
    };
  }

  /** The pull request's conversation as the spec sees it, from its store and its told prompts. */
  private async pullRequestView(
    firings: number[],
  ): Promise<Pick<FiringsView, "pullWorkflows" | "pullSeen" | "pullPrompts">> {
    const conversation = this.conversations.get(await conversationIdOf(PULL_REQUEST_PLACE));
    if (!conversation) return { pullWorkflows: [], pullSeen: [], pullPrompts: [] };
    const workflowIds = [...new Set(conversation.prompts.map(({ workflowId }) => workflowId))];
    const rows = storeRowsOf(conversation.store).workflows as {
      workflow_id: string;
      status: string;
    }[];
    if (rows.length !== workflowIds.length) {
      throw new Error(
        `the conversation holds ${rows.length} workflows but prompted ${workflowIds.length}`,
      );
    }
    return {
      pullWorkflows: workflowIds.map((workflowId) =>
        workflowStatusText(rows.find((row) => row.workflow_id === workflowId)!.status),
      ),
      pullSeen: firings.filter((firing) =>
        conversation.runtime.store.eventSeen(firingKey(pullFiringBody(firing))),
      ),
      pullPrompts: conversation.prompts.map(({ firing, workflowId }) => ({
        firing,
        workflow: workflowIds.indexOf(workflowId),
      })),
    };
  }

  private isPullFiring(firing: number): boolean {
    const { scheduled, channelEvents } = SETUP_FIRINGS[this.setup];
    return firing >= scheduled + channelEvents;
  }

  /** The queue body of a firing's first attempt, as the scheduled run or the router queues it. */
  private firingBody(firing: number): TriggerFiring {
    if (this.isPullFiring(firing)) return pullFiringBody(firing);
    if (firing >= SETUP_FIRINGS[this.setup].scheduled) return channelEventFiringBody(firing);
    return scheduledFiringBody(firing);
  }

  /** Put the real clock back. */
  close(): void {
    setSystemTime();
  }

  private runScheduledMinute(firing: number, late: boolean): void {
    const scheduledTime = FIRST_MINUTE_MS + firing * MINUTE_MS;
    setSystemTime(new Date(scheduledTime + (late ? LATE_MS : ON_TIME_MS)));
    for (const body of scheduledFirings([DEFINITION], scheduledTime)) {
      this.messages.push({ body, delay: 0, acked: false });
    }
  }

  /** The router fires the vendor event of a pull request firing, with the firing in its payload. */
  private fireThePullRequestEvent(firing: number): Promise<void> {
    return this.fireVendorEvent({
      ...vendorEventOf(firing, PULL_REQUEST_EVENT),
      enrichment: { kind: "pull_request", ...PULL_REQUEST },
    });
  }

  private async fireVendorEvent(event: VendorEvent): Promise<void> {
    await fireMatchingTriggers(
      {
        definitions: [DEFINITION],
        resolveActor: async () => ({ email: "octocat@acme.test", display_name: "octocat" }),
        sendFirings: async (firings) => {
          for (const body of firings) this.messages.push({ body, delay: 0, acked: false });
        },
      },
      event,
    );
  }

  /** The pull request merges. Its conversation's real handler starts the watcher's end and arms the alarm that goes on with it. */
  private async closeThePullRequest(): Promise<void> {
    const conversation = this.conversationFor(await conversationIdOf(PULL_REQUEST_PLACE));
    this.closes += 1;
    const merged: InboundEvent = {
      id: `merged-${this.closes}`,
      kind: "pr_event",
      actor: null,
      bindings: [{ source: "code_pull", ...PULL_REQUEST }],
      links: [],
      text: "",
      pull: { action: "closed", ...PULL_REQUEST, merged: true },
    };
    await handleEvent(conversation.runtime, merged);
  }

  /** The alarm that goes on with the end fires, its held end post returns, and the end finishes. */
  private async finishTheWatcherEnd(): Promise<void> {
    const { runtime, endPosts } = this.conversationFor(await conversationIdOf(PULL_REQUEST_PLACE));
    const [alarm, ...others] = runtime.alarmsFor("resumeWorkflowEnd");
    if (!alarm || others.length > 0) throw new Error("the workflow end does not have one alarm");
    await runtime.cancelAlarm(alarm.id);
    const postsBefore = endPosts.length;
    let settled = false;
    const ending = resumeWorkflowEnd(runtime).finally(() => {
      settled = true;
    });
    await waitFor(
      () => settled || endPosts.length > postsBefore,
      "the workflow end neither finished nor posted",
    );
    if (settled) throw new Error("the workflow end finished without its post");
    endPosts.at(-1)!.resolve();
    await ending;
    await this.quiet();
  }

  /** The pull request's conversation restarts. Its handlers are lost. */
  private async restartThePullRequestConversation(): Promise<void> {
    const conversationId = await conversationIdOf(PULL_REQUEST_PLACE);
    const conversation = this.conversationFor(conversationId);
    const restarted = conversation.runtime.restarted();
    holdConversationCalls(restarted, conversation);
    conversation.runtime = restarted;
    await startRestartedInstance(restarted);
    for (const delivery of this.deliveries) {
      const call = delivery.held;
      if (call?.kind !== "fire" || call.conversationId !== conversationId || !call.tell) continue;
      delivery.held = null;
      call.answer.reject(new Error("the conversation restarted"));
    }
    await this.quiet();
  }

  private async deliver(id: number): Promise<void> {
    const message = this.messages[id];
    if (!message) throw new Error(`the replay has no message ${id}`);
    const delivery: ReplayDelivery = {
      message: id,
      held: null,
      settled: false,
      died: false,
      retried: false,
      sent: false,
      taken: false,
      failureLinePlace: null,
    };
    this.deliveries.push(delivery);
    const consumer = {
      db: this.db,
      chat: new DeliveryChat({
        post: () =>
          this.hold(delivery, { kind: "post", answer: new Deferred<{ ts: string }>() }).promise,
        reply: (replyThread) => {
          const thread = threadOf(replyThread);
          delivery.failureLinePlace = `InThread(${thread})`;
          this.failureLineCalls.set(thread, (this.failureLineCalls.get(thread) ?? 0) + 1);
          return this.hold(delivery, {
            kind: "failureLine",
            place: `InThread(${thread})`,
            answer: new Deferred<FailureLineAnswer>(),
          }).promise;
        },
      }),
      code: new DeliveryCodeHost(() => {
        delivery.failureLinePlace = "OnThePullRequest";
        this.failureComments += 1;
        return this.hold(delivery, {
          kind: "failureLine",
          place: "OnThePullRequest",
          answer: new Deferred<FailureLineAnswer>(),
        }).promise;
      }),
      definitions: [DEFINITION],
      fire: (conversationId: string, firing: ConversationFiring) =>
        this.hold(delivery, {
          kind: "fire",
          place: placeTextOf(firing),
          conversationId,
          firing,
          answer: new Deferred<FiringAnswer>(),
          handler: null,
          tell: null,
        }).promise,
      sendAttempt: (firing: TriggerFiring, delaySeconds: number) =>
        this.hold(delivery, { kind: "send", firing, delaySeconds, answer: new Deferred<void>() })
          .promise,
    };
    void consumeFiringMessage(consumer, {
      body: message.body,
      ack: () => {
        message.acked = true;
      },
      retry: () => {
        delivery.retried = true;
      },
    }).then(() => {
      delivery.settled = true;
    });
    await this.quiet();
  }

  private hold<Call extends HeldCall>(delivery: ReplayDelivery, call: Call): Call["answer"] {
    if (delivery.held) throw new Error(`delivery ${delivery.message} made two calls at once`);
    delivery.held = call;
    return call.answer;
  }

  private heldCall<Kind extends HeldCall["kind"]>(
    index: number,
    kind: Kind,
  ): { delivery: ReplayDelivery; call: Extract<HeldCall, { kind: Kind }> } {
    const delivery = this.deliveries[index];
    const call = delivery?.held;
    if (!delivery || call?.kind !== kind) {
      throw new Error(`delivery ${index} does not wait on a ${kind} call`);
    }
    return { delivery, call: call as Extract<HeldCall, { kind: Kind }> };
  }

  private async answerStartLine(index: number, posted: boolean): Promise<void> {
    const { delivery, call } = this.heldCall(index, "post");
    delivery.held = null;
    if (posted) {
      const thread = this.startLines.length;
      this.startLines.push(firingOf(this.messageOf(delivery).body));
      call.answer.resolve({ ts: threadTs(thread) });
    } else {
      call.answer.reject(new Error("the chat refused the start line"));
    }
    await this.quiet();
  }

  private async takeTheFiring(index: number): Promise<void> {
    const { delivery, call } = this.heldCall(index, "fire");
    const conversation = this.conversationFor(call.conversationId);
    const toldBefore = conversation.tells.length;
    let answered = false;
    const handler = fireWorkflow(conversation.runtime, {
      conversationId: call.conversationId,
      firing: call.firing,
    });
    call.handler = handler;
    void handler.finally(() => {
      answered = true;
    });
    await waitFor(
      () => answered || conversation.tells.length > toldBefore,
      "the conversation neither answered nor told its agent",
    );
    if (conversation.tells.length > toldBefore) {
      call.tell = conversation.tells.at(-1)!;
      return;
    }
    await this.answerWith(delivery, call, handler);
  }

  private async answerTheFiring(index: number): Promise<void> {
    const { delivery, call } = this.heldCall(index, "fire");
    if (!call.tell || !call.handler) throw new Error(`delivery ${index} has no handler to answer`);
    call.tell.resolve();
    await this.answerWith(delivery, call, call.handler);
  }

  private async answerWith(
    delivery: ReplayDelivery,
    call: Extract<HeldCall, { kind: "fire" }>,
    handler: Promise<FiringAnswer>,
  ): Promise<void> {
    const answer = await handler;
    delivery.held = null;
    delivery.taken =
      answer.kind === "started" || answer.kind === "prompted" || answer.kind === "duplicate";
    call.answer.resolve(answer);
    await this.quiet();
  }

  private async failTheCall(index: number): Promise<void> {
    const { delivery, call } = this.heldCall(index, "fire");
    delivery.held = null;
    call.answer.reject(new Error("the conversation call failed"));
    await this.quiet();
  }

  private async restartTheConversation(index: number): Promise<void> {
    const { delivery, call } = this.heldCall(index, "fire");
    const conversation = this.conversationFor(call.conversationId);
    const restarted = conversation.runtime.restarted();
    holdConversationCalls(restarted, conversation);
    conversation.runtime = restarted;
    await runStartStep(restarted);
    delivery.held = null;
    call.answer.reject(new Error("the conversation restarted"));
    await this.quiet();
  }

  private async answerTheSend(index: number, sent: boolean): Promise<void> {
    const { delivery, call } = this.heldCall(index, "send");
    delivery.held = null;
    if (sent) {
      this.messages.push({ body: call.firing, delay: call.delaySeconds, acked: false });
      delivery.sent = true;
      call.answer.resolve();
    } else {
      call.answer.reject(new Error("the queue refused the send"));
    }
    await this.quiet();
  }

  private async answerTheFailureLine(index: number, posted: boolean): Promise<void> {
    const { delivery, call } = this.heldCall(index, "failureLine");
    delivery.held = null;
    if (posted) call.answer.resolve({ ts: "1.0", id: 1 });
    else call.answer.reject(new Error("the chat refused the failure line"));
    await this.quiet();
  }

  private killTheConsumer(index: number, landed: boolean): void {
    const delivery = this.deliveries[index];
    const call = delivery?.held;
    if (!delivery || !call) throw new Error(`delivery ${index} does not wait on a call`);
    delivery.held = null;
    delivery.died = true;
    if (!landed) return;
    if (call.kind === "post") this.startLines.push(firingOf(this.messageOf(delivery).body));
    if (call.kind === "send") {
      this.messages.push({ body: call.firing, delay: call.delaySeconds, acked: false });
    }
  }

  private messageOf(delivery: ReplayDelivery): QueuedMessage {
    return this.messages[delivery.message]!;
  }

  private conversationFor(conversationId: string): ReplayConversation {
    const known = this.conversations.get(conversationId);
    if (known) return known;
    const store = openMemoryDb();
    const runtime = new FakeRuntime(store, { ...testEnv(), DB: this.d1 }, "uncreated");
    runtime.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions({}) });
    const conversation: ReplayConversation = {
      runtime,
      store,
      tells: [],
      prompts: [],
      endPosts: [],
    };
    holdConversationCalls(runtime, conversation);
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  /** True when the thread's conversation saw its firing, created its workflow and told its agent once. */
  private startedIn(conversation: ReplayConversation, thread: number): boolean {
    const { store, notes } = conversation.runtime;
    const seen = store.eventSeen(firingKey(this.firingBody(this.startLines[thread]!)));
    const created = store.workflowRow() !== null;
    if (seen !== created || notes.length !== (created ? 1 : 0)) {
      throw new Error(
        `the conversation of thread ${thread} saw its firing ${String(seen)}, created ${String(created)} and told its agent ${notes.length} times`,
      );
    }
    return created;
  }

  private quiet(): Promise<void> {
    return waitFor(
      () => this.deliveries.every((delivery) => delivery.died || delivery.settled || delivery.held),
      "a consumer neither returned nor waited on a call",
    );
  }
}

/**
 * Make each agent tell of the conversation wait until the spec answers the conversation's call,
 * and record the pull request firing it prompts. Make the post of each done end wait until the
 * spec finishes that end.
 */
function holdConversationCalls(runtime: FakeRuntime, conversation: ReplayConversation): void {
  runtime.tellAgent = async (text, wake, from) => {
    const workflowId = runtime.store.activeWorkflow()?.workflow_id;
    const firing = /\{"firing":(\d+)\}/.exec(text)?.[1];
    if (workflowId && firing !== undefined) {
      conversation.prompts.push({ firing: Number(firing), workflowId });
    }
    await FakeRuntime.prototype.tellAgent.call(runtime, text, wake, from);
    const tell = new Deferred<void>();
    conversation.tells.push(tell);
    await tell.promise;
  };
  runtime.post = async (event, to, options) => {
    if (event.type === "done") {
      const post = new Deferred<void>();
      conversation.endPosts.push(post);
      await post.promise;
    }
    return FakeRuntime.prototype.post.call(runtime, event, to, options);
  };
}

function workflowStatusText(status: string): string {
  switch (status) {
    case "ending":
      return "WorkflowEnding";
    case "ended":
      return "WorkflowEnded";
    default:
      return "WorkflowRunning";
  }
}

function phaseText(delivery: ReplayDelivery): string {
  if (delivery.died) return "Died";
  if (delivery.settled) return `Finished(${endingText(delivery)})`;
  const call = delivery.held;
  if (!call) throw new Error(`delivery of message ${delivery.message} is not quiet`);
  switch (call.kind) {
    case "post":
      return "PostOut";
    case "fire":
      return call.tell ? `Answering(${call.place})` : `CallOut(${call.place})`;
    case "send":
      return "SendOut";
    case "failureLine":
      return `FailureLineOut(${call.place})`;
    default: {
      const unreachable: never = call;
      throw new Error(`unhandled held call ${JSON.stringify(unreachable)}`);
    }
  }
}

function endingText(delivery: ReplayDelivery): string {
  if (delivery.retried) return "Redelivered";
  if (delivery.sent) return "NextAttemptSent";
  if (delivery.taken) return "Taken";
  if (delivery.failureLinePlace === null) return "GaveUp(NoPlace)";
  return `GaveUp(At(${delivery.failureLinePlace}))`;
}

function scheduledFiringBody(firing: number): TriggerFiring {
  return {
    cause: {
      kind: "schedule",
      minute: new Date(FIRST_MINUTE_MS + firing * MINUTE_MS).toISOString(),
    },
    reports: { kind: "channel", channel: CHANNEL },
    definition: DEFINITION.name,
    position: 0,
    attempt: 1,
  };
}

function pullFiringBody(firing: number): TriggerFiring {
  return {
    cause: vendorEventCauseOf(firing, PULL_REQUEST_EVENT),
    reports: { kind: "pull_request", ...PULL_REQUEST },
    definition: DEFINITION.name,
    position: 1,
    attempt: 1,
  };
}

function channelEventFiringBody(firing: number): TriggerFiring {
  return {
    cause: vendorEventCauseOf(firing, CHANNEL_EVENT),
    reports: { kind: "channel", channel: CHANNEL },
    definition: DEFINITION.name,
    position: 2,
    attempt: 1,
  };
}

function vendorEventCauseOf(firing: number, event: string): TriggerFiring["cause"] {
  return {
    kind: "vendor_event",
    delivery_id: deliveryIdOf(firing),
    event,
    payload: JSON.stringify({ firing }),
  };
}

/** The vendor event of one firing, by a person, with the firing in its payload. */
function vendorEventOf(firing: number, name: string): VendorEvent {
  return {
    delivery_id: deliveryIdOf(firing),
    name,
    payload: { firing },
    causer: { source: "code", user: { login: "octocat", repo: PULL_REQUEST.repo, app: false } },
    about_app: false,
  };
}

function deliveryIdOf(firing: number): string {
  return `d-${firing}`;
}

function firingOf(body: TriggerFiring): number {
  const { cause } = body;
  switch (cause.kind) {
    case "schedule":
      return (Date.parse(cause.minute) - FIRST_MINUTE_MS) / MINUTE_MS;
    case "vendor_event":
      return Number(cause.delivery_id.slice("d-".length));
    default: {
      const unreachable: never = cause;
      throw new Error(`unhandled firing cause ${String(unreachable)}`);
    }
  }
}

function placeTextOf({ origin }: ConversationFiring): PlaceText {
  return origin.source === "chat" ? `InThread(${threadOf(origin.thread)})` : "OnThePullRequest";
}

function threadTs(thread: number): string {
  return `${FIRST_LINE_SECONDS + thread}.000100`;
}

function threadOf(ts: string): number {
  return Number(ts.split(".")[0]) - FIRST_LINE_SECONDS;
}

function placeOf(thread: number) {
  return { source: "chat_thread", channel: CHANNEL, thread: threadTs(thread) } as const;
}

async function waitFor(done: () => boolean, stuck: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!done()) {
    if (performance.now() > deadline) throw new Error(stuck);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function required<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`the spec step did not pick a ${name}`);
  return value;
}
