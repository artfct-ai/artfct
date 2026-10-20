import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { spyOn, type Mock } from "bun:test";
import { deliverWithChatAck } from "../src/router/chat-ack";
import { Deferred } from "./deferred";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";

/** The setup modules of the chat acknowledgement spec. */
export const SPEC_SETUPS = ["twoMessages", "threeMessages"] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

/** The eyes delay each message waits. The replay checks that the eyes timer waits exactly this long. */
const DELAY_MS = 3_000;

const EYES = "eyes";

const CHANNEL = "C1";

const SOURCES = ["Chat", "Tracker"] as const;

type SourceName = (typeof SOURCES)[number];

const OUTCOMES = ["Pending", "Returned", "Threw"] as const;

const SETTLED_OUTCOMES = ["Returned", "Threw"] as const;

/** What a delivery settled with or what the caller got. `Mismatched` is a caller result the delivery did not give. */
type OutcomeName = (typeof OUTCOMES)[number] | "Mismatched";

const CALL_STATES = ["NotSent", "Out", "Accepted", "Refused", "Unanswered"] as const;

type CallStateName = (typeof CALL_STATES)[number];

/** One message as the spec sees it, without the facts only the clock knows. */
type MessageView = {
  source: SourceName;
  delivery: OutcomeName;
  add: CallStateName;
  addsSent: number;
  remove: CallStateName;
  removesSent: number;
  callerGot: OutcomeName;
};

/** Every message in arrival order, the eyes timers still armed, and the chat calls no message accounts for. */
export type AcknowledgementView = {
  messages: MessageView[];
  armedTimers: number;
  strayChatCalls: number;
};

/** What a spec action picked. */
type SpecPicks = {
  source: SourceName | null;
  id: number | null;
  accepted: boolean | null;
  outcome: (typeof SETTLED_OUTCOMES)[number] | null;
};

/** One state of a trace: the action that led to it, what it picked, and the messages as the spec sees them. */
export type TraceStep = { action: string; picks: SpecPicks; view: AcknowledgementView };

/** Run the spec of one setup for `count` traces from `seed`. */
export async function generateTraces(
  setup: SpecSetup,
  count: number,
  seed: number,
): Promise<TraceStep[][]> {
  return quintTraces(
    {
      spec: "chat-acknowledgement",
      setup,
      count,
      steps: TRACE_STEPS,
      seed,
    },
    (trace) => traceSteps(trace),
  );
}

function traceSteps(trace: unknown): TraceStep[] {
  return itfList(itfField(trace, "states")).map((state) => {
    const messagesName = Object.keys(asRecord(state)).find((name) => name.endsWith("::messages"));
    if (!messagesName) throw new Error("the trace has no messages");
    const picks = itfField(state, "mbt::nondetPicks");
    const accepted = pickedValue(picks, "accepted");
    const outcome = pickedValue(picks, "outcome");
    return {
      action: itfText(itfField(state, "mbt::actionTaken")),
      picks: {
        source: pickedTag(picks, "source", SOURCES),
        id: pickedInt(picks, "id"),
        accepted: accepted === null ? null : itfBool(accepted),
        outcome: outcome === null ? null : itfOneOf(itfVariant(outcome)!.tag, SETTLED_OUTCOMES),
      },
      view: specView(itfField(state, messagesName)),
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

function pickedTag<Name extends string>(
  picks: unknown,
  name: string,
  names: readonly Name[],
): Name | null {
  const value = pickedValue(picks, name);
  return value === null ? null : itfOneOf(itfVariant(value)!.tag, names);
}

function tagOf<Name extends string>(value: unknown, names: readonly Name[]): Name {
  return itfOneOf(itfVariant(value)!.tag, names);
}

function specView(messages: unknown): AcknowledgementView {
  const byId = itfList(itfField(messages, "#map"))
    .map((pair) => {
      const [id, message] = itfList(pair);
      return { id: itfInt(id), message };
    })
    .toSorted((left, right) => left.id - right.id);
  return {
    messages: byId.map(({ message }) => ({
      source: tagOf(itfField(message, "source"), SOURCES),
      delivery: tagOf(itfField(message, "delivery"), OUTCOMES),
      add: tagOf(itfField(message, "add"), CALL_STATES),
      addsSent: itfInt(itfField(message, "addsSent")),
      remove: tagOf(itfField(message, "remove"), CALL_STATES),
      removesSent: itfInt(itfField(message, "removesSent")),
      callerGot: tagOf(itfField(message, "callerGot"), OUTCOMES),
    })),
    armedTimers: byId.filter(({ message }) => itfBool(itfField(message, "timerArmed"))).length,
    strayChatCalls: 0,
  };
}

function asRecord(value: unknown): object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`the trace has ${JSON.stringify(value)}, not a record`);
  }
  return value;
}

/** One reaction call the chat holds until the spec answers it. */
type HeldReaction = { answer: Deferred<void>; state: CallStateName };

/** The reaction calls on one message. */
type MessageReactions = { adds: HeldReaction[]; removes: HeldReaction[] };

/** A chat whose eyes calls wait for the replay to accept or refuse them. Any other call is stray. */
class HeldReactionChat extends FakeChat {
  readonly reactions = new Map<string, MessageReactions>();
  strayReactions = 0;

  override addReaction(channel: string, ts: string, name: string): Promise<void> {
    return this.hold(channel, ts, name, "adds");
  }

  override removeReaction(channel: string, ts: string, name: string): Promise<void> {
    return this.hold(channel, ts, name, "removes");
  }

  private hold(
    channel: string,
    ts: string,
    name: string,
    kind: keyof MessageReactions,
  ): Promise<void> {
    const reactions = this.reactions.get(ts);
    if (!reactions || channel !== CHANNEL || name !== EYES) {
      this.strayReactions += 1;
      return Promise.resolve();
    }
    const answer = new Deferred<void>();
    reactions[kind].push({ answer, state: "Out" });
    return answer.promise;
  }
}

/** A timer the chat acknowledgement armed. It fires only when the replay fires it. */
type HeldTimer = { callback: () => void; ms: number; state: "armed" | "fired" | "cleared" };

function clearHeldTimer(timer?: HeldTimer): void {
  if (timer?.state === "armed") timer.state = "cleared";
}

/** Holds every timer the code arms, so each one fires when the spec says and not before. */
class HeldTimers {
  readonly timers: HeldTimer[] = [];
  private readonly spies: Mock<(...args: never[]) => unknown>[];

  constructor() {
    const arm = (callback: () => void, ms?: number): HeldTimer => {
      const timer: HeldTimer = { callback, ms: ms ?? 0, state: "armed" };
      this.timers.push(timer);
      return timer;
    };
    this.spies = [
      spyOn(globalThis, "setTimeout").mockImplementation(arm as unknown as typeof setTimeout),
      spyOn(globalThis, "clearTimeout").mockImplementation(
        clearHeldTimer as unknown as typeof clearTimeout,
      ),
    ];
  }

  /** The timers armed from the place `from` in arming order on. */
  armedSince(from: number): HeldTimer[] {
    return this.timers.slice(from).filter((timer) => timer.state === "armed");
  }

  fire(timer: HeldTimer): void {
    if (timer.state !== "armed") return;
    timer.state = "fired";
    timer.callback();
  }

  restore(): void {
    for (const spy of this.spies) spy.mockRestore();
  }
}

/** One message the replay delivered, its timers, and what its caller got so far. */
type DeliveredMessage = {
  source: SourceName;
  ts: string;
  delayTimer: HeldTimer | null;
  addWaitTimer: HeldTimer | null;
  delivery: Deferred<string>;
  value: string;
  error: Error;
  settled: OutcomeName;
  callerGot: OutcomeName;
};

/**
 * Replays spec traces through the chat acknowledgement. Each delivery, each eyes call and each
 * timer waits until a spec step settles or fires it.
 */
export class ChatAcknowledgementReplay {
  private readonly chat = new HeldReactionChat();
  private readonly timers = new HeldTimers();
  private readonly messages: DeliveredMessage[] = [];
  private delaysPassed = 0;

  /** Take one spec action. */
  async take(step: TraceStep): Promise<void> {
    const { picks } = step;
    switch (step.action) {
      case "messageArrives":
        this.arrive(required(picks.source, "source"));
        break;
      case "delayPasses":
        this.passTheNextDelay();
        break;
      case "addReturns":
        this.answer(required(picks.id, "id"), "adds", required(picks.accepted, "accepted"));
        break;
      case "deliverySettles":
        await this.settle(required(picks.id, "id"), required(picks.outcome, "outcome"));
        break;
      case "addWaitRunsOut":
        this.endAddWait(required(picks.id, "id"));
        break;
      case "removeReturns":
        this.answer(required(picks.id, "id"), "removes", required(picks.accepted, "accepted"));
        break;
      case "finished":
        break;
      default:
        throw new Error(`no replay for spec action ${step.action}`);
    }
    await drainMicrotasks();
  }

  /** The messages as the spec sees them. */
  project(): AcknowledgementView {
    return {
      messages: this.messages.map((message) => {
        const reactions = this.chat.reactions.get(message.ts)!;
        return {
          source: message.source,
          delivery: message.settled,
          add: lastState(reactions.adds),
          addsSent: reactions.adds.length,
          remove: lastState(reactions.removes),
          removesSent: reactions.removes.length,
          callerGot: message.callerGot,
        };
      }),
      armedTimers: this.timers.armedSince(0).filter((timer) => !this.isAddWaitOfAnOutAdd(timer))
        .length,
      strayChatCalls: this.chat.strayReactions + this.chat.calls.length,
    };
  }

  /** Put the real timers back. */
  close(): void {
    this.timers.restore();
  }

  private arrive(source: SourceName): void {
    const index = this.messages.length;
    const ts = `2.${index}`;
    const armedBefore = this.timers.timers.length;
    const message: DeliveredMessage = {
      source,
      ts,
      delayTimer: null,
      addWaitTimer: null,
      delivery: new Deferred<string>(),
      value: `delivered ${ts}`,
      error: new Error(`workflow unavailable for ${ts}`),
      settled: "Pending",
      callerGot: "Pending",
    };
    this.messages.push(message);
    this.chat.reactions.set(ts, { adds: [], removes: [] });
    deliverWithChatAck(
      this.chat,
      eventFor(source, ts),
      () => message.delivery.promise,
      DELAY_MS,
    ).then(
      (value) => {
        message.callerGot = value === message.value ? "Returned" : "Mismatched";
      },
      (error: unknown) => {
        message.callerGot = error === message.error ? "Threw" : "Mismatched";
      },
    );
    message.delayTimer = this.timers.armedSince(armedBefore)[0] ?? null;
  }

  private passTheNextDelay(): void {
    const id = this.delaysPassed;
    const { delayTimer } = this.messageAt(id);
    this.delaysPassed += 1;
    if (!delayTimer) return;
    if (delayTimer.ms !== DELAY_MS) {
      throw new Error(
        `message ${id} armed its eyes timer for ${delayTimer.ms} ms, not ${DELAY_MS}`,
      );
    }
    this.timers.fire(delayTimer);
  }

  private async settle(id: number, outcome: (typeof SETTLED_OUTCOMES)[number]): Promise<void> {
    const message = this.messageAt(id);
    const armedBefore = this.timers.timers.length;
    message.settled = outcome;
    if (outcome === "Returned") message.delivery.resolve(message.value);
    else message.delivery.reject(message.error);
    await drainMicrotasks();
    message.addWaitTimer = this.timers.armedSince(armedBefore)[0] ?? null;
  }

  private endAddWait(id: number): void {
    const message = this.messageAt(id);
    const add = this.chat.reactions
      .get(message.ts)!
      .adds.findLast((reaction) => reaction.state === "Out");
    if (!message.addWaitTimer || !add) {
      throw new Error(`message ${id} does not wait on an eyes add`);
    }
    add.state = "Unanswered";
    this.timers.fire(message.addWaitTimer);
  }

  private isAddWaitOfAnOutAdd(timer: HeldTimer): boolean {
    return this.messages.some(
      (message) =>
        message.addWaitTimer === timer &&
        lastState(this.chat.reactions.get(message.ts)!.adds) === "Out",
    );
  }

  private answer(id: number, kind: keyof MessageReactions, accepted: boolean): void {
    const { ts } = this.messageAt(id);
    const calls = this.chat.reactions.get(ts)![kind];
    const held = calls.findLast((reaction) => reaction.state === "Out");
    if (!held) throw new Error(`message ${id} has no eyes call out to answer`);
    held.state = accepted ? "Accepted" : "Refused";
    if (accepted) held.answer.resolve();
    else held.answer.reject(new Error(`${kind} refused`));
  }

  private messageAt(id: number): DeliveredMessage {
    const message = this.messages[id];
    if (!message) throw new Error(`the replay has no message ${id}`);
    return message;
  }
}

function lastState(calls: HeldReaction[]): CallStateName {
  return calls.at(-1)?.state ?? "NotSent";
}

function eventFor(source: SourceName, ts: string): InboundEvent {
  const base: InboundEvent = {
    id: `evt-${ts}`,
    kind: "prompt",
    actor: { email: "dev@acme.test", display_name: "Dev" },
    bindings: [],
    links: [],
    text: "also add a test",
  };
  const acknowledge = { message: ts, user: "U1" };
  if (source === "Chat") {
    return {
      ...base,
      reply_to: { source: "chat", channel: CHANNEL, thread: "1.0" },
      acknowledge,
    };
  }
  return {
    ...base,
    reply_to: { source: "tracker", session_id: "s1", issue_id: "i1" },
    acknowledge,
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let round = 0; round < 50; round++) await Promise.resolve();
}

function required<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`the spec step did not pick a ${name}`);
  return value;
}
