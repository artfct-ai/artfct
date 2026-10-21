import { z } from "zod";
import type { JsonValue } from "@artfct-ai/contracts/types";
import { isNotionConversationalEvent } from "./conversational-events";
import { notionVendorEventName } from "./vendor-event-name";
import type { DocumentsVendorEvent } from "../types";

/** The author type Notion gives a person. A bot, such as the app itself, has another. */
const PERSON_AUTHOR_TYPE = "person";

const notionVendorEventSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
  authors: z.array(z.object({ id: z.string(), type: z.string() })).nullish(),
});

/**
 * Turn a verified Notion webhook into a vendor event, or drop it with its reason. It drops a
 * conversational event, an event without an author, and an event a bot took part in, which
 * covers the app itself. The causer is the first author. Notion names authors by id
 * alone, so access looks up the email.
 */
export function notionVendorEvent(payload: JsonValue): DocumentsVendorEvent {
  const parsed = notionVendorEventSchema.safeParse(payload);
  if (!parsed.success) return { drop: "malformed notion webhook" };
  const name = notionVendorEventName(parsed.data.type);
  if (isNotionConversationalEvent(name)) return { drop: "conversational" };
  const authors = parsed.data.authors ?? [];
  const [causer] = authors;
  if (!causer) return { drop: "no causer" };
  if (authors.some((author) => author.type !== PERSON_AUTHOR_TYPE)) {
    return { drop: "caused by a bot" };
  }
  return {
    event: {
      delivery_id: parsed.data.id,
      name,
      payload,
      causer: { source: "documents", user: { id: causer.id } },
      about_app: false,
    },
  };
}
