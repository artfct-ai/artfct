import { configuredVendors, conversationalEvents, vendorEventIsAboutPull } from "../clients";
import type { Adapters } from "./adapters";
import type { EventTrigger, WorkflowDefinition } from "./workflow-definition";

/**
 * Why an event trigger of the definition cannot fire. Its event names a vendor the deployment
 * does not configure, or one of the conversational events. A pull request event reports on its
 * pull request, so it takes no channel, and any other event needs one. Null when every trigger
 * can fire.
 */
export function eventTriggersProblem(
  definition: WorkflowDefinition,
  adapters: Adapters,
): string | null {
  for (const [position, trigger] of definition.triggers.entries()) {
    if (!("event" in trigger)) continue;
    const problem = eventTriggerProblem(trigger, adapters);
    if (problem) return `workflows/${definition.name}.yaml triggers[${position}]: ${problem}`;
  }
  return null;
}

/** Why one event trigger cannot fire, or null. */
function eventTriggerProblem(trigger: EventTrigger, adapters: Adapters): string | null {
  const vendors = configuredVendors(adapters);
  const vendor = trigger.event.slice(0, trigger.event.indexOf("."));
  if (!vendors.includes(vendor)) {
    return `${trigger.event} names ${vendor}, which the deployment does not configure. Its vendors are ${vendors.join(", ")}`;
  }
  if (conversationalEvents(adapters).includes(trigger.event)) {
    return `${trigger.event} is a conversational event. It reaches its conversation as a start or a message, and never fires a trigger`;
  }
  const aboutPull = vendorEventIsAboutPull(adapters, trigger.event);
  if (aboutPull && trigger.channel !== undefined) {
    return `channel: ${trigger.event} reports on its pull request, so it does not take a channel`;
  }
  if (!aboutPull && trigger.channel === undefined) {
    return `channel: ${trigger.event} needs a channel to report in`;
  }
  return null;
}
