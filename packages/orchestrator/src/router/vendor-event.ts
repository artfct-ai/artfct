import type { Actor } from "@artfct-ai/contracts/inbound";
import type {
  VendorEvent,
  VendorEventCauser,
  VendorEventDelivery,
} from "@artfct-ai/contracts/types";
import type { EventTrigger, WorkflowDefinition } from "../config/workflow-definition";
import { matchingTriggers } from "../triggers/match";
import { renderedPayload } from "../triggers/payload";
import type { FiringReport, TriggerFiring } from "../triggers/types";

/** What the router needs to fire a vendor event's triggers. */
export type TriggerRouter = {
  definitions: readonly WorkflowDefinition[];
  resolveActor: (causer: VendorEventCauser) => Promise<Actor | null>;
  /** Queue the first attempt of each firing. */
  sendFirings: (firings: TriggerFiring[]) => Promise<void>;
};

/** What the router needs to route a vendor event: its triggers, and the greeting of a joined channel. */
export type VendorEventRouter = TriggerRouter & {
  /** Post the greeting in a channel the app joined. */
  greet: (channel: string) => Promise<void>;
};

/**
 * Fire the vendor event's matching triggers. When the event is the app joining a channel and it
 * queues no firing, the app posts the greeting in that channel.
 */
export async function routeVendorEvent(
  router: VendorEventRouter,
  event: VendorEvent,
): Promise<VendorEventDelivery> {
  const delivery = await fireMatchingTriggers(router, event);
  const channel = joinedChannelOfApp(event);
  const fired = "firings" in delivery && delivery.firings > 0;
  if (channel !== null && !fired) await router.greet(channel);
  return delivery;
}

/** The channel an event about the app names, which is the app joining it. Null for any other event. */
function joinedChannelOfApp(event: VendorEvent): string | null {
  if (!event.about_app || event.enrichment?.kind !== "channel") return null;
  return event.enrichment.channel;
}

/**
 * Match the vendor event against every event trigger before any call. An unmatched event stops there.
 * After a match, the causer must pass access, and each matching trigger queues one firing with the
 * payload rendered within its cap.
 */
export async function fireMatchingTriggers(
  router: TriggerRouter,
  event: VendorEvent,
): Promise<VendorEventDelivery> {
  const matched = matchingTriggers(router.definitions, event);
  if (matched.length === 0) return { dropped: `no trigger matches ${event.name}` };
  if (!(await router.resolveActor(event.causer))) {
    return { dropped: "the causer is not authorized" };
  }
  const payload = renderedPayload(event.payload);
  const firings = matched.flatMap(({ definition, position, trigger }): TriggerFiring[] => {
    const reports = firingReportOf(trigger, event);
    if (!reports) {
      console.error(
        `${event.name} matched ${definition} triggers[${position}], which reports nowhere`,
      );
      return [];
    }
    const cause = {
      kind: "vendor_event",
      delivery_id: event.delivery_id,
      event: event.name,
      payload,
    } as const;
    return [{ cause, reports, definition, position, attempt: 1 }];
  });
  if (firings.length) await router.sendFirings(firings);
  return { firings: firings.length };
}

/**
 * Where a matched trigger's firing reports: the trigger's channel, else the pull request or the
 * channel the adapter named. Null when none is there, which config load rules out.
 */
function firingReportOf(trigger: EventTrigger, event: VendorEvent): FiringReport | null {
  if (trigger.channel !== undefined) return { kind: "channel", channel: trigger.channel };
  const { enrichment } = event;
  switch (enrichment?.kind) {
    case undefined:
      return null;
    case "pull_request":
      return { kind: "pull_request", repo: enrichment.repo, number: enrichment.number };
    case "channel":
      return { kind: "channel", channel: enrichment.channel };
    default: {
      const unreachable: never = enrichment;
      throw new Error(`unhandled enrichment ${String(unreachable)}`);
    }
  }
}
