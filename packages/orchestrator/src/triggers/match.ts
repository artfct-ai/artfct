import type { VendorEvent } from "@artfct-ai/contracts/types";
import type { EventTrigger, WorkflowDefinition } from "../config/workflow-definition";

/** One trigger a vendor event matched, with its definition and its place in that definition's list. */
export type MatchedTrigger = { definition: string; position: number; trigger: EventTrigger };

/** Filter paths under this prefix read what the adapter says about the event, not its payload. */
const ADAPTER_FIELDS_PREFIX = "artfct.";

/** The value at a filter path of the event. Undefined when the path does not resolve. */
function valueAtPath(event: VendorEvent, path: string): unknown {
  if (path.startsWith(ADAPTER_FIELDS_PREFIX)) {
    return path === `${ADAPTER_FIELDS_PREFIX}about_app` ? event.about_app : undefined;
  }
  let value: unknown = event.payload;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** True when the value is an accepted one, or a list that holds one. */
function filterHolds(value: unknown, accepted: readonly unknown[]): boolean {
  const candidates: unknown[] = Array.isArray(value) ? value : [value];
  return candidates.some((candidate) => accepted.includes(candidate));
}

/** True when the trigger names the event and every one of its filters holds. */
function triggerMatches(trigger: EventTrigger, event: VendorEvent): boolean {
  if (trigger.event !== event.name) return false;
  return Object.entries(trigger.filters).every(([path, accepted]) => {
    return filterHolds(valueAtPath(event, path), accepted);
  });
}

/** Every event trigger of the definitions that the vendor event matches, in config order. */
export function matchingTriggers(
  definitions: readonly WorkflowDefinition[],
  event: VendorEvent,
): MatchedTrigger[] {
  return definitions.flatMap((definition) =>
    definition.triggers.flatMap((trigger, position) => {
      if (!("event" in trigger) || !triggerMatches(trigger, event)) return [];
      return [{ definition: definition.name, position, trigger }];
    }),
  );
}
