import { describe, it } from "bun:test";
import type { JsonValue } from "@artfct-ai/contracts/types";
import fc from "fast-check";
import { fakeUserActor } from "../../../test/fake-actors";
import {
  aConversationalEventNeverFires,
  anIgnoredVendorEventNeverFires,
  type IgnoredVendorEventCause,
} from "../../../test/inbound-invariants";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { isSlackConversationalEvent } from "./conversational-events";
import { slackInbound } from "./inbound";
import { slackVendorEvent } from "./vendor-event";

const RUNS = 200;

const APP_USER = "UBOT";

const EVENT_TYPES = [
  "app_mention",
  "message",
  "reaction_added",
  "member_joined_channel",
  "member_left_channel",
  "channel_archive",
  "pin_added",
];

type Delivery = {
  type: string;
  user: string | null;
  inviter: string | null;
  shared: boolean;
  botId: string | null;
  text: string;
  threaded: boolean;
};

const delivery: fc.Arbitrary<Delivery> = fc.record({
  type: fc.constantFrom(...EVENT_TYPES),
  user: fc.option(fc.constantFrom(APP_USER, "U1", "U2"), { nil: null }),
  inviter: fc.option(fc.constantFrom(APP_USER, "U1"), { nil: null }),
  shared: fc.boolean(),
  botId: fc.option(fc.constantFrom("B1", "BOTHER"), { nil: null }),
  text: fc.constantFrom("<@UBOT> ship it", "also add a test", ""),
  threaded: fc.boolean(),
});

function callback(scenario: Delivery): JsonValue {
  return {
    type: "event_callback",
    event_id: "Ev1",
    authorizations: [{ user_id: APP_USER }],
    is_ext_shared_channel: scenario.shared,
    event: {
      type: scenario.type,
      channel: "C1",
      ts: "1700.2",
      text: scenario.text,
      reaction: "white_check_mark",
      item: { type: "message", channel: "C1", ts: "1700.2" },
      ...(scenario.threaded ? { thread_ts: "1700.1" } : {}),
      ...(scenario.user ? { user: scenario.user } : {}),
      ...(scenario.inviter ? { inviter: scenario.inviter } : {}),
      ...(scenario.botId ? { bot_id: scenario.botId } : {}),
    },
  };
}

/** Why the pass-through must drop the delivery, or null when it may pass it. */
function ignoredCauseOf(scenario: Delivery): IgnoredVendorEventCause | null {
  if (scenario.shared) return "shared_channel";
  const causer = scenario.inviter ?? scenario.user;
  if (!causer) return "no_causer";
  if (causer === APP_USER) return "caused_by_the_app";
  return null;
}

async function checkDelivery(scenario: Delivery): Promise<void> {
  const payload = callback(scenario);
  const name = `slack.${scenario.type}`;
  const conversational = isSlackConversationalEvent(name);
  const passed = slackVendorEvent(payload);
  aConversationalEventNeverFires({ step: "pass_through", name, conversational, value: passed });
  const cause = ignoredCauseOf(scenario);
  if (cause) anIgnoredVendorEventNeverFires(cause, passed);
  const mapped = await slackInbound(payload, {
    resolveActor: fakeUserActor(),
    chat: null,
    reaction: "white_check_mark",
  });
  aConversationalEventNeverFires({ step: "mapper", name, conversational, value: mapped });
}

describe("the slack pass-through", () => {
  it(
    "never passes a conversational event, a shared channel's event, or the app's own event",
    async () => {
      await fc.assert(
        fc.asyncProperty(delivery, checkDelivery),
        propertyRuns("slack pass-through", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
