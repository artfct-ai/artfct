import type { JsonValue } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { notionVendorEvent } from "./vendor-event";
import { notionVendorEventName } from "./vendor-event-name";

function pageCreated(fields: Record<string, JsonValue> = {}): JsonValue {
  return {
    id: "evt1",
    timestamp: "2026-09-03T10:00:00.000Z",
    workspace_id: "ws1",
    subscription_id: "sub1",
    integration_id: "int1",
    attempt_number: 1,
    type: "page.created",
    authors: [{ id: "n1", type: "person" }],
    entity: { id: "pg1", type: "page" },
    data: { parent: { id: "db1", type: "database" } },
    ...fields,
  };
}

describe("notionVendorEventName", () => {
  it("prefixes the type in Notion's case", () => {
    expect(notionVendorEventName("page.created")).toBe("notion.page.created");
  });
});

describe("notionVendorEvent", () => {
  it("passes a page a person created, with the first author as the causer", () => {
    const payload = pageCreated();
    expect(notionVendorEvent(payload)).toEqual({
      event: {
        delivery_id: "evt1",
        name: "notion.page.created",
        payload,
        causer: { source: "documents", user: { id: "n1" } },
        about_app: false,
      },
    });
  });

  it("drops a comment, the conversational event", () => {
    expect(notionVendorEvent(pageCreated({ type: "comment.created" }))).toEqual({
      drop: "conversational",
    });
  });

  it("drops an event the app's own integration took part in", () => {
    const authors = [
      { id: "n1", type: "person" },
      { id: "bot1", type: "bot" },
    ];
    expect(notionVendorEvent(pageCreated({ authors }))).toEqual({ drop: "caused by a bot" });
  });

  it.each([
    ["an empty author list", []],
    ["no author list", null],
  ])("drops an event with %s", (_case, authors) => {
    expect(notionVendorEvent(pageCreated({ authors }))).toEqual({ drop: "no causer" });
  });

  it("drops a payload that is not a Notion webhook", () => {
    expect(notionVendorEvent(["page.created"])).toEqual({ drop: "malformed notion webhook" });
  });
});
