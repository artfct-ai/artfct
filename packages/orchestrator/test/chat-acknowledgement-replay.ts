import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { jest } from "bun:test";
import { deliverWithChatAck } from "../src/router/chat-ack";
import { itfBool, itfField, itfInt, itfList, itfOneOf, itfText, itfVariant } from "./itf";
import { quintTraces } from "./quint-traces";

/** The setup modules of the chat acknowledgement spec. */
export const SPEC_SETUPS = ["twoMessages", "threeMessages"] as const;

/** The name of one setup module of the spec. */
export type SpecSetup = (typeof SPEC_SETUPS)[number];

/** The most steps a generated trace takes after its initial state. */
const TRACE_STEPS = 25;

/** The eyes delay of the first message. Each later message waits one millisecond longer, so no two delays end at once. */
const DELAY_MS = 3_000;

const EYES = "eyes";

const CHANNEL = "C1";

const SOURCES = ["Chat", "Tracker"] as const;

type SourceName = (typeof SOURCES)[number];

const OUTCOMES = ["Pending", "Returned", "Threw"] as const;

const SETTLED_OUTCOMES = ["Returned", "Threw"] as const;

/** What a delivery settled with or what the caller got. `Mismatched` is a caller result the delivery did not give. */
type OutcomeName = (typeof OUTCOMES)[number] | "Mismatched";

const CALL_STATES = ["NotSent", "Out", "Accepted", "Refused"] as const;

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
  const traces = await quintTraces({
    spec: "chat-acknowledgement",
    setup,
    count,
    steps: TRACE_STEPS,
    seed,
  });
  return traces.map((trace) => traceSteps(trace));
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

/** A promise the replay settles when the spec says so. */
class Deferred<Value> {
  resolve: (value: Value) => void = () => {};
  reject: (error: Error) => void = () => {};
  readonly promise = new Promise<Value>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
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

/** One message the replay delivered, and what its caller got so far. */
type DeliveredMessage = {
  source: SourceName;
  ts: string;
  deadlineMs: number;
  delivery: Deferred<string>;
  value: string;
  error: Error;
  settled: OutcomeName;
  callerGot: OutcomeName;
};

/**
 * Replays spec traces through the chat acknowledgement on fake timers. Each delivery and each
 * eyes call waits until a spec step settles it.
 */
export class ChatAcknowledgementReplay {
  private readonly chat = new HeldReactionChat();
  private readonly messages: DeliveredMessage[] = [];
  private elapsedMs = 0;
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
        this.settle(required(picks.id, "id"), required(picks.outcome, "outcome"));
        break;
      case "removeReturns":
        this.answer(required(picks.id, "id"), "removes", required(picks.accepted, "accepted"));
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
      armedTimers: jest.getTimerCount(),
      strayChatCalls: this.chat.strayReactions + this.chat.calls.length,
    };
  }

  private arrive(source: SourceName): void {
    const index = this.messages.length;
    const ts = `2.${index}`;
    const delayMs = DELAY_MS + index;
    const message: DeliveredMessage = {
      source,
      ts,
      deadlineMs: this.elapsedMs + delayMs,
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
      delayMs,
    ).then(
      (value) => {
        message.callerGot = value === message.value ? "Returned" : "Mismatched";
      },
      (error: unknown) => {
        message.callerGot = error === message.error ? "Threw" : "Mismatched";
      },
    );
  }

  private passTheNextDelay(): void {
    const message = this.messageAt(this.delaysPassed);
    this.delaysPassed += 1;
    jest.advanceTimersByTime(message.deadlineMs - this.elapsedMs);
    this.elapsedMs = message.deadlineMs;
  }

  private settle(id: number, outcome: (typeof SETTLED_OUTCOMES)[number]): void {
    const message = this.messageAt(id);
    message.settled = outcome;
    if (outcome === "Returned") message.delivery.resolve(message.value);
    else message.delivery.reject(message.error);
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
    actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
    bindings: [],
    links: [],
    text: "also add a test",
  };
  if (source === "Chat") {
    return {
      ...base,
      reply_to: { source: "chat", channel: CHANNEL, thread: "1.0" },
      acknowledge: { message: ts, user: "U1" },
    };
  }
  return { ...base, reply_to: { source: "tracker", session_id: "s1", issue_id: "i1" } };
}

async function drainMicrotasks(): Promise<void> {
  for (let round = 0; round < 50; round++) await Promise.resolve();
}

function required<Value>(value: Value | null, name: string): Value {
  if (value === null) throw new Error(`the spec step did not pick a ${name}`);
  return value;
}
