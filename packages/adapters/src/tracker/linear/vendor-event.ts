import { z } from "zod";
import type { JsonValue, TrackerInstall } from "@artfct-ai/contracts/types";
import { isLinearConversationalEvent } from "./conversational-events";
import { linearEventId } from "./inbound-event-id";
import { linearWebhookSchema } from "./inbound-payloads";
import { linearVendorEventName } from "./vendor-event-name";
import type { TrackerVendorEvent } from "../types";

/** The actor type Linear gives a person. A bot or an OAuth client has another. */
const PERSON_ACTOR_TYPE = "user";

const vendorEventPayloadSchema = z.object({
  actor: z
    .object({
      id: z.string(),
      type: z.string(),
      email: z.string().toLowerCase().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
});

/** What the Linear pass-through needs besides the delivery. */
export type LinearVendorEventContext = {
  /** The deployment's install. Null before the install, when every workspace is another one. */
  install: TrackerInstall | null;
  /** The `Linear-Delivery` header. Null when Linear sends none. */
  deliveryId: string | null;
};

/**
 * Turn a verified Linear webhook into a vendor event, or drop it with its reason. It drops a
 * conversational event, an event of another workspace, an event no person caused, and an event
 * the app's own user caused.
 */
export async function linearVendorEvent(
  payload: JsonValue,
  context: LinearVendorEventContext,
): Promise<TrackerVendorEvent> {
  const webhook = linearWebhookSchema.safeParse(payload);
  if (!webhook.success) return { drop: "malformed linear webhook" };
  const name = linearVendorEventName(webhook.data.type, webhook.data.action);
  if (isLinearConversationalEvent(name)) return { drop: "conversational" };
  const { install } = context;
  if (!install || webhook.data.organizationId !== install.workspace_id) {
    return { drop: "another workspace" };
  }
  const parsed = vendorEventPayloadSchema.safeParse(payload);
  if (!parsed.success) return { drop: `malformed ${name}` };
  const { actor } = parsed.data;
  if (!actor || actor.type !== PERSON_ACTOR_TYPE) return { drop: "no causer" };
  if (actor.id === install.app_user_id) return { drop: "caused by the app" };
  return {
    event: {
      delivery_id: await linearEventId(webhook.data, context.deliveryId),
      name,
      payload,
      causer: {
        source: "tracker",
        user: { id: actor.id, email: actor.email ?? null, name: actor.name ?? null },
      },
      about_app: false,
    },
  };
}
