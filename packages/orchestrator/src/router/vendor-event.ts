import type { Actor } from "@artfct-ai/contracts/inbound";
import type { IdentityQuery, VendorEvent, VendorEventDelivery } from "@artfct-ai/contracts/types";
import type { EventTrigger, WorkflowDefinition } from "../config/workflow-definition";
import { matchingTriggers } from "../triggers/match";
import { renderedPayload } from "../triggers/payload";
import type { FiringReport, TriggerFiring } from "../triggers/types";

/** What the router needs to fire a vendor event's triggers. */
export type VendorEventRouter = {
  definitions: readonly WorkflowDefinition[];
  resolveActor: (query: IdentityQuery) => Promise<Actor | null>;
  /** Queue the first attempt of each firing. */
  sendFirings: (firings: TriggerFiring[]) => Promise<void>;
};

/**
 * Match the vendor event against every event trigger before any call. An unmatched event stops there.
 * After a match, the causer must pass access, and each matching trigger queues one firing with the
 * payload rendered within its cap.
 */
export async function fireMatchingTriggers(
  router: VendorEventRouter,
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
 * Where a matched trigger's firing reports: the trigger's channel, else the pull request the
 * adapter named. Null when neither is there, which config load rules out.
 */
function firingReportOf(trigger: EventTrigger, event: VendorEvent): FiringReport | null {
  if (trigger.channel !== undefined) return { kind: "channel", channel: trigger.channel };
  const { enrichment } = event;
  if (enrichment?.kind !== "pull_request") return null;
  return { kind: "pull_request", repo: enrichment.repo, number: enrichment.number };
}
