import { z } from "zod";
import type { JsonValue } from "@artfct-ai/contracts/types";
import { isSlackConversationalEvent } from "./conversational-events";
import { isSlackJoinedChannelEventName, slackVendorEventName } from "./vendor-event-name";
import type { ChatVendorEvent } from "../types";

const vendorEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string(),
  event: z.object({
    type: z.string(),
    user: z.string().optional().catch(undefined),
    inviter: z.string().optional().catch(undefined),
    channel: z.string().optional().catch(undefined),
  }),
  authorizations: z.array(z.object({ user_id: z.string() })).optional(),
  is_ext_shared_channel: z.boolean().optional(),
});

/** The inner event of a callback the schema accepted, which is the vendor event's payload. */
function innerEvent(callback: JsonValue): JsonValue {
  if (typeof callback !== "object" || callback === null || Array.isArray(callback)) return null;
  return callback.event ?? null;
}

/**
 * Turn a verified Slack event callback into a vendor event, or drop it with its reason. It drops a
 * conversational event, a Slack Connect channel, an event without a causer, and an event the app
 * caused. The causer is the inviter of a member who was invited, else the event's user. An event
 * whose user is the app is about the app. A member joining a channel names that channel.
 */
export function slackVendorEvent(callback: JsonValue): ChatVendorEvent {
  const parsed = vendorEventCallbackSchema.safeParse(callback);
  if (!parsed.success) return { drop: "malformed slack event callback" };
  const { event, event_id: deliveryId, authorizations } = parsed.data;
  const name = slackVendorEventName(event.type);
  if (isSlackConversationalEvent(name)) return { drop: "conversational" };
  if (parsed.data.is_ext_shared_channel) return { drop: "Slack Connect channel" };
  const causer = event.inviter ?? event.user;
  if (!causer) return { drop: "no causer" };
  const appUserId = authorizations?.[0]?.user_id;
  if (causer === appUserId) return { drop: "caused by the app" };
  const joinedChannel = isSlackJoinedChannelEventName(name) ? event.channel : undefined;
  return {
    event: {
      delivery_id: deliveryId,
      name,
      payload: innerEvent(callback),
      causer: { source: "chat", user_id: causer },
      about_app: appUserId !== undefined && event.user === appUserId,
      ...(joinedChannel ? { enrichment: { kind: "channel", channel: joinedChannel } } : {}),
    },
  };
}
