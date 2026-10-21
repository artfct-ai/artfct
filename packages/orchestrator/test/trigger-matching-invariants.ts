import type { VendorEvent } from "@artfct-ai/contracts/types";
import type { EventTrigger, WorkflowDefinition } from "../src/config/workflow-definition";
import type { TriggerFiring } from "../src/triggers/types";

/** The most UTF-8 bytes of payload one firing may carry. */
const PAYLOAD_CAP_BYTES = 16 * 1024;

/** How the causer's access lookup answered in one run. */
export type CauserLookup = "authorized" | "unauthorized" | "error";

/**
 * One vendor event the router took: the definitions it knew, the event, how the access lookup
 * answered, how many lookups it made, and the firings it queued.
 */
export type VendorEventRun = {
  definitions: readonly WorkflowDefinition[];
  event: VendorEvent;
  lookup: CauserLookup;
  lookups: number;
  sent: TriggerFiring[];
};

function violated(name: string, detail: string): never {
  throw new Error(`${name}: ${detail}`);
}

/** Each queued firing names a trigger whose event name is the event's and whose every filter holds. */
export function aTriggerFiresOnlyWhenEveryFilterHolds(run: VendorEventRun): void {
  for (const firing of run.sent) {
    const trigger = run.definitions.find(({ name }) => name === firing.definition)?.triggers[
      firing.position
    ];
    if (!trigger || !("event" in trigger) || !triggerAccepts(trigger, run.event)) {
      violated(
        "aTriggerFiresOnlyWhenEveryFilterHolds",
        `${firing.definition} triggers[${firing.position}] fired on ${run.event.name}`,
      );
    }
  }
}

/** An event that no trigger accepts makes no lookup and queues no firing. */
export function anUnmatchedEventStaysInMemory(run: VendorEventRun): void {
  if (anyTriggerAccepts(run)) return;
  if (run.lookups > 0 || run.sent.length > 0) {
    violated(
      "anUnmatchedEventStaysInMemory",
      `${run.event.name} matched nothing but made ${run.lookups} lookups and ${run.sent.length} firings`,
    );
  }
}

/** A causer whose lookup does not authorize them fires nothing. */
export function aTriggerFiresOnlyForAnAuthorizedCauser(run: VendorEventRun): void {
  if (run.lookup === "authorized" || run.sent.length === 0) return;
  violated(
    "aTriggerFiresOnlyForAnAuthorizedCauser",
    `a causer whose lookup was ${run.lookup} fired ${run.sent.length} firings`,
  );
}

/** Every queued firing carries at most 16 KB of payload. */
export function aTriggeredPayloadStaysWithinItsCap(run: VendorEventRun): void {
  for (const { cause } of run.sent) {
    if (cause.kind !== "vendor_event") continue;
    const bytes = new TextEncoder().encode(cause.payload).length;
    if (bytes > PAYLOAD_CAP_BYTES) {
      violated("aTriggeredPayloadStaysWithinItsCap", `a firing carried ${bytes} bytes of payload`);
    }
  }
}

/**
 * What the router did with one Slack join. `appJoined` is the channel the app was added to, or
 * null when a person joined.
 */
export type JoinOutcome = {
  appJoined: string | null;
  firings: readonly TriggerFiring[];
  greeted: readonly string[];
};

/**
 * A channel the app is added to gets the greeting once, unless a trigger fires for the join. Then
 * it gets no greeting. A person joining never gets the greeting.
 */
export function aJoinedChannelIsGreetedUnlessATriggerFires(outcome: JoinOutcome): void {
  const name = "aJoinedChannelIsGreetedUnlessATriggerFires";
  const greeted = JSON.stringify(outcome.greeted);
  if (outcome.appJoined === null) {
    if (outcome.greeted.length) violated(name, `a person joined, and the app greeted ${greeted}`);
    return;
  }
  if (outcome.firings.length) {
    if (outcome.greeted.length) violated(name, `a trigger fired, and the app greeted ${greeted}`);
    return;
  }
  if (greeted !== JSON.stringify([outcome.appJoined])) {
    violated(name, `no trigger fired in ${outcome.appJoined}, and the app greeted ${greeted}`);
  }
}

function anyTriggerAccepts(run: VendorEventRun): boolean {
  return run.definitions.some(({ triggers }) =>
    triggers.some((trigger) => "event" in trigger && triggerAccepts(trigger, run.event)),
  );
}

function triggerAccepts(trigger: EventTrigger, event: VendorEvent): boolean {
  if (trigger.event !== event.name) return false;
  return Object.entries(trigger.filters).every(([path, accepted]) => {
    const found = resolvedPath(event, path);
    if (!found.resolved) return false;
    const values: unknown[] = Array.isArray(found.value) ? found.value : [found.value];
    return values.some((value) => (accepted as readonly unknown[]).includes(value));
  });
}

function resolvedPath(
  event: VendorEvent,
  path: string,
): { resolved: true; value: unknown } | { resolved: false } {
  if (path === "artfct.about_app") return { resolved: true, value: event.about_app };
  if (path.startsWith("artfct.")) return { resolved: false };
  let value: unknown = event.payload;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
      return { resolved: false };
    }
    value = (value as Record<string, unknown>)[key];
  }
  return { resolved: true, value };
}
