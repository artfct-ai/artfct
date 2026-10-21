import type { ExternalUser } from "@artfct-ai/contracts/types";

/** What one inbound mapper did with one payload: the value it returned, or what it threw. */
export type MapperOutcome =
  | { kind: "returned"; value: unknown }
  | { kind: "threw"; error: unknown };

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/**
 * An inbound mapper returns an event, or an ignore that names its reason, for any payload. It
 * never throws.
 */
export function inboundMapperNeverThrows(outcome: MapperOutcome): void {
  if (outcome.kind === "threw") {
    violated("inboundMapperNeverThrows", `the mapper threw ${String(outcome.error)}`);
  }
  if (isEventOrIgnore(outcome.value)) return;
  violated("inboundMapperNeverThrows", `the mapper returned ${describe(outcome.value)}`);
}

/**
 * Every email an inbound mapper hands the actor resolver is lowercase, so the email join does not
 * depend on the case a vendor reports.
 */
export function actorEmailIsLowercase(asked: ExternalUser[]): void {
  for (const user of asked) {
    if (user.email && user.email !== user.email.toLowerCase()) {
      violated("actorEmailIsLowercase", `the mapper asked about ${user.email}`);
    }
  }
}

/** What one step did with a vendor event name, and whether its vendor lists that name as conversational. */
export type NamedEventOutcome =
  | { step: "pass_through"; name: string; conversational: boolean; value: unknown }
  | { step: "mapper"; name: string; conversational: boolean; value: unknown }
  | { step: "config_load"; name: string; conversational: boolean; accepted: boolean };

/** Why a vendor pass-through must drop a delivery, as the generator built it. */
export type IgnoredVendorEventCause =
  | "caused_by_the_app"
  | "another_workspace"
  | "fork"
  | "no_causer";

const MESSAGE_KINDS = new Set(["start", "prompt", "feedback"]);

/**
 * A conversational event never fires a trigger. The pass-through drops it, config load rejects a
 * trigger on it, and the mapper turns no other name into a start or a message.
 */
export function aConversationalEventNeverFires(outcome: NamedEventOutcome): void {
  const { name, conversational } = outcome;
  switch (outcome.step) {
    case "pass_through":
      if (conversational && carriesEvent(outcome.value)) {
        violated("aConversationalEventNeverFires", `the pass-through passed ${name}`);
      }
      return;
    case "mapper":
      if (!conversational && isMessage(outcome.value)) {
        violated("aConversationalEventNeverFires", `the mapper made a message of ${name}`);
      }
      return;
    case "config_load":
      if (conversational && outcome.accepted) {
        violated("aConversationalEventNeverFires", `config load accepted a trigger on ${name}`);
      }
      return;
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled step ${String(unreachable)}`);
    }
  }
}

/**
 * A pass-through drops an event the app caused, an event of another workspace, a fork's pull
 * request, and an event without a causer. Another App's event passes.
 */
export function anIgnoredVendorEventNeverFires(
  cause: IgnoredVendorEventCause,
  value: unknown,
): void {
  if (!carriesEvent(value)) return;
  violated(
    "anIgnoredVendorEventNeverFires",
    `the pass-through passed an event with cause ${cause}`,
  );
}

/** Runs one mapper call and records how it settled. */
export async function mapperOutcome(map: () => unknown): Promise<MapperOutcome> {
  try {
    return { kind: "returned", value: await map() };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function carriesEvent(value: unknown): boolean {
  return typeof value === "object" && value !== null && "event" in value;
}

function isMessage(value: unknown): boolean {
  if (!carriesEvent(value)) return false;
  const { event } = value as { event: unknown };
  if (typeof event !== "object" || event === null || !("kind" in event)) return false;
  return typeof event.kind === "string" && MESSAGE_KINDS.has(event.kind);
}

function isEventOrIgnore(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ("ignore" in value) return typeof value.ignore === "string" && value.ignore !== "";
  if ("event" in value) return typeof value.event === "object" && value.event !== null;
  return false;
}

function describe(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 200) ?? String(value);
}
