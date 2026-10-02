import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { linearEventId } from "./inbound-event-id";
import type { IssuePayload } from "./inbound-payloads";
import type { TrackerInbound, TrackerInboundContext } from "../types";

/** Linear state types that end an issue. */
const ENDING_STATE_TYPES = ["canceled", "completed"];

/**
 * A person moving an issue into a canceled or completed state cancels the work on it. Only a
 * person ends work that way. Every other state change is ignored.
 */
export async function linearIssueEvent(
  payload: IssuePayload,
  context: TrackerInboundContext,
): Promise<TrackerInbound> {
  const state = payload.data.state;
  const previousStateId = payload.updatedFrom?.stateId;
  if (!state || !previousStateId || previousStateId === state.id) {
    return { ignore: "issue update without state change" };
  }
  if (!ENDING_STATE_TYPES.includes(state.type)) return { ignore: `state ${state.name}` };

  const actor = payload.actor ? await context.resolveActor(payload.actor) : null;
  if (!actor) return { ignore: `state ${state.name} from no person` };
  const event: InboundEvent = {
    id: await linearEventId(payload, context.deliveryId),
    kind: "control",
    control: "cancel",
    actor,
    bindings: [{ source: "tracker_issue", external_id: payload.data.id }],
    links: [],
    text: `Issue moved to ${state.name}`,
  };
  return { event };
}
