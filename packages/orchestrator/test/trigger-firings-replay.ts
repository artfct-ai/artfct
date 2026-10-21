import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { setSystemTime } from "bun:test";
import { loadWorkflowDefinition } from "../src/config/workflow-definition";
import { createDb, type Database } from "../src/db/client";
import { conversationIdOf, conversationRecorded } from "../src/db/conversations";
import { recordedFiringThread } from "../src/db/firing-threads";
import { firingKey } from "../src/triggers/firing-key";
import { consumeFiringMessage } from "../src/triggers/firing-queue";
import { scheduledFirings } from "../src/triggers/schedule";
import type { ConversationFiring, FiringAnswer, TriggerFiring } from "../src/triggers/types";
import { fireWorkflow } from "../src/workflow/inbound/firing";
import { Deferred } from "./deferred";
import { FakeRuntime } from "./fake-runtime";
import { itfBool, itfField, itfInt, itfList, itfSet, itfText, itfVariant } from "./itf";
import { openMemoryDb } from "./memory-db";
import { quintTraces } from "./quint-traces";
import { runStartStep } from "./restart";
import { sqliteD1 } from "./sqlite-d1";
import { TEST_CONFIG, TEST_DEFINITION_NAME } from "./test-config";
import { testEnv } from "./test-env";

/** The setup modules of the trigger firings spec. */
export const SPEC_SETUPS = ["twoMinutes"] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

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

/** The test workflow definition with a trigger that fires every minute. */
const DEFINITION = loadWorkflowDefinition(
  TEST_DEFINITION_NAME,
  [
    TEST_CONFIG.workflowDefinitions[0]!.text,
    "triggers:",
    `  - { schedule: "* * * * *", channel: ${CHANNEL}, prompt: Upgrade the dependencies. }`,
  ].join("\n"),
);

/** One attempt in the queue, as the spec sees it. */
type MessageView = { firing: number; attempt: number; delay: number; acked: boolean };

/** One queue delivery, as the spec sees it, with its phase written as the spec's variant. */
type DeliveryView = { message: number; phase: string };

/** The queue, the chat, D1 and the conversations, as the spec sees them. */
export type FiringsView = {
  messages: MessageView[];
  deliveries: DeliveryView[];
  startLines: number[];
  records: [number, number][];
  recordedConversations: number[];
  startedConversations: number[];
  failureLines: [number, number][];
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
  };
}

function asRecord(value: unknown): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the trace has ${JSON.stringify(value)}, not a record`);
  }
  return value;
}

/** A call the consumer of one delivery waits on until the spec answers it. */
type HeldCall =
  | { kind: "post"; answer: Deferred<{ ts: string }> }
  | {
      kind: "fire";
      thread: number;
      conversationId: string;
      firing: ConversationFiring;
      answer: Deferred<FiringAnswer>;
      handler: Promise<FiringAnswer> | null;
      tell: Deferred<void> | null;
    }
  | { kind: "send"; firing: TriggerFiring; delaySeconds: number; answer: Deferred<void> }
  | { kind: "failureLine"; thread: number; answer: Deferred<{ ts: string }> };

/** One run of the real consumer on one queue message. */
type ReplayDelivery = {
  message: number;
  held: HeldCall | null;
  settled: boolean;
  died: boolean;
  retried: boolean;
  sent: boolean;
  taken: boolean;
  failureLineThread: number | null;
};

/** One attempt in the fake queue. */
type QueuedMessage = { body: TriggerFiring; delay: number; acked: boolean };

/** One conversation, by its id, and the agent tells it holds until the spec answers them. */
type ReplayConversation = { runtime: FakeRuntime; tells: Deferred<void>[] };

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
  private readonly d1 = sqliteD1();
  private readonly db: Database = createDb(this.d1);
  private readonly messages: QueuedMessage[] = [];
  private readonly deliveries: ReplayDelivery[] = [];
  private readonly startLines: number[] = [];
  private readonly failureLineCalls = new Map<number, number>();
  private readonly conversations = new Map<string, ReplayConversation>();

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "theScheduledRunQueues":
        this.runScheduledMinute(required(picks.firing, "firing"), required(picks.late, "late"));
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
    for (const firing of firings) {
      const recorded = await recordedFiringThread(this.db, firingBody(firing));
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
    };
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
      failureLineThread: null,
    };
    this.deliveries.push(delivery);
    const consumer = {
      db: this.db,
      chat: new DeliveryChat({
        post: () =>
          this.hold(delivery, { kind: "post", answer: new Deferred<{ ts: string }>() }).promise,
        reply: (replyThread) => {
          const thread = threadOf(replyThread);
          delivery.failureLineThread = thread;
          this.failureLineCalls.set(thread, (this.failureLineCalls.get(thread) ?? 0) + 1);
          return this.hold(delivery, {
            kind: "failureLine",
            thread,
            answer: new Deferred<{ ts: string }>(),
          }).promise;
        },
      }),
      definitions: [DEFINITION],
      fire: (conversationId: string, firing: ConversationFiring) =>
        this.hold(delivery, {
          kind: "fire",
          thread: threadOf(firing.thread),
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
    delivery.taken = answer.kind !== "active_workflow";
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
    holdTells(restarted, conversation.tells);
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
    if (posted) call.answer.resolve({ ts: "1.0" });
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
    const runtime = new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: this.d1 }, "uncreated");
    const conversation: ReplayConversation = { runtime, tells: [] };
    holdTells(runtime, conversation.tells);
    this.conversations.set(conversationId, conversation);
    return conversation;
  }

  /** True when the thread's conversation saw its firing, created its workflow and told its agent once. */
  private startedIn(conversation: ReplayConversation, thread: number): boolean {
    const { store, notes } = conversation.runtime;
    const seen = store.eventSeen(firingKey(firingBody(this.startLines[thread]!)));
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

/** Make each agent tell of the conversation wait until the spec answers the conversation's call. */
function holdTells(runtime: FakeRuntime, tells: Deferred<void>[]): void {
  runtime.tellAgent = async (text, wake, from) => {
    await FakeRuntime.prototype.tellAgent.call(runtime, text, wake, from);
    const tell = new Deferred<void>();
    tells.push(tell);
    await tell.promise;
  };
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
      return call.tell ? `Answering(${call.thread})` : `CallOut(${call.thread})`;
    case "send":
      return "SendOut";
    case "failureLine":
      return `FailureLineOut(${call.thread})`;
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
  if (delivery.failureLineThread === null) return "GaveUp(NoThread)";
  return `GaveUp(InThread(${delivery.failureLineThread}))`;
}

function firingBody(firing: number): TriggerFiring {
  return {
    cause: {
      kind: "schedule",
      minute: new Date(FIRST_MINUTE_MS + firing * MINUTE_MS).toISOString(),
    },
    definition: DEFINITION.name,
    position: 0,
    attempt: 1,
  };
}

function firingOf(body: TriggerFiring): number {
  return (Date.parse(body.cause.minute) - FIRST_MINUTE_MS) / MINUTE_MS;
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
