import type { JsonValue } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { slackVendorEvent } from "./vendor-event";
import { isSlackJoinedChannelEventName, slackVendorEventName } from "./vendor-event-name";

function callback(event: { [key: string]: JsonValue }, shared = false): JsonValue {
  return {
    type: "event_callback",
    event_id: "Ev1",
    event,
    authorizations: [{ user_id: "UBOT" }],
    is_ext_shared_channel: shared,
  };
}

const APP_JOINED_ALONE = { type: "member_joined_channel", user: "UBOT", channel: "C1" };

const APP_ADDED = { ...APP_JOINED_ALONE, inviter: "U1" };

describe("slackVendorEventName", () => {
  it("prefixes the inner event's type", () => {
    expect(slackVendorEventName("channel_archive")).toBe("slack.channel_archive");
  });
});

describe("isSlackJoinedChannelEventName", () => {
  it("holds for a member joining a channel", () => {
    expect(isSlackJoinedChannelEventName("slack.member_joined_channel")).toBe(true);
  });

  it("does not hold for a member leaving one", () => {
    expect(isSlackJoinedChannelEventName("slack.member_left_channel")).toBe(false);
  });
});

describe("slackVendorEvent", () => {
  it("passes the app being added to a channel, caused by its inviter, with the channel", () => {
    expect(slackVendorEvent(callback(APP_ADDED))).toEqual({
      event: {
        delivery_id: "Ev1",
        name: "slack.member_joined_channel",
        payload: APP_ADDED,
        causer: { source: "chat", user_id: "U1" },
        about_app: true,
        enrichment: { kind: "channel", channel: "C1" },
      },
    });
  });

  it("passes a person joining a channel as not about the app", () => {
    const joined = { type: "member_joined_channel", user: "U2", channel: "C1" };
    expect(slackVendorEvent(callback(joined))).toMatchObject({
      event: {
        causer: { source: "chat", user_id: "U2" },
        about_app: false,
        enrichment: { kind: "channel", channel: "C1" },
      },
    });
  });

  it("passes another event without a channel to report in", () => {
    const archived = { type: "channel_archive", user: "U1", channel: "C1" };
    const passed = slackVendorEvent(callback(archived));
    expect(passed).toMatchObject({ event: { name: "slack.channel_archive", about_app: false } });
    expect("event" in passed && passed.event.enrichment).toBeUndefined();
  });

  it.each(["app_mention", "message", "reaction_added"])("drops the conversational %s", (type) => {
    const event = { type, user: "U1", channel: "C1", ts: "1700.1", text: "hi" };
    expect(slackVendorEvent(callback(event))).toEqual({ drop: "conversational" });
  });

  it("drops an event from a Slack Connect channel", () => {
    expect(slackVendorEvent(callback(APP_ADDED, true))).toEqual({ drop: "Slack Connect channel" });
  });

  it("drops the app joining a channel on its own, which the app caused", () => {
    expect(slackVendorEvent(callback(APP_JOINED_ALONE))).toEqual({ drop: "caused by the app" });
  });

  it("drops an event without a causer", () => {
    const created = { type: "channel_created", channel: { id: "C2", creator: "U1" } };
    expect(slackVendorEvent(callback(created))).toEqual({ drop: "no causer" });
  });

  it("drops a payload that is not an event callback", () => {
    expect(slackVendorEvent({ type: "url_verification", challenge: "c" })).toEqual({
      drop: "malformed slack event callback",
    });
  });
});
