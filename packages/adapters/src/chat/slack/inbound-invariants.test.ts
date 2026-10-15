import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns } from "../../../test/property-runs";
import { fakeUserActor } from "../../../test/fake-actors";
import { inboundMapperNeverThrows, mapperOutcome } from "../../../test/inbound-invariants";
import { anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { appJoinedChannel, slackInbound } from "./inbound";
import type { ChatInboundContext, ChatLookup } from "../types";

const lookup: ChatLookup = {
  user: async (userId) => ({ id: userId, email: "dev@acme.test", member_of_team: "T1" }),
  threadRootTs: async () => "1756893600.000100",
};

const envelope = {
  token: "verification-token-legacy",
  team_id: "T1",
  api_app_id: "A1",
  type: "event_callback",
  event_id: "Ev1",
  event_time: 1756893600,
  is_ext_shared_channel: false,
  authorizations: [{ user_id: "UBOT" }],
};

const realPayloads: Record<string, unknown> = {
  app_mention: {
    ...envelope,
    event: {
      type: "app_mention",
      user: "U1",
      text: "<@UBOT> fix <https://github.com/acme/app|the app>",
      ts: "1756893600.000100",
      thread_ts: "1756893500.000100",
      channel: "C1",
    },
  },
  message: {
    ...envelope,
    event: {
      type: "message",
      user: "U1",
      text: "also add a test",
      ts: "1756893700.000100",
      thread_ts: "1756893600.000100",
      channel: "C1",
    },
  },
  reaction_added: {
    ...envelope,
    event: {
      type: "reaction_added",
      user: "U1",
      reaction: "white_check_mark",
      item: { type: "message", channel: "C1", ts: "1756893700.000100" },
    },
  },
  member_joined_channel: {
    ...envelope,
    event: { type: "member_joined_channel", user: "UBOT", channel: "C1" },
  },
};

function isChannelOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

async function checkPayload(payload: unknown, withBot: boolean): Promise<void> {
  const context: ChatInboundContext = {
    resolveActor: fakeUserActor(),
    chat: withBot ? lookup : null,
    reaction: "white_check_mark",
  };
  inboundMapperNeverThrows(await mapperOutcome(() => slackInbound(payload, context)));
  const joined = await mapperOutcome(() => appJoinedChannel(payload));
  expect(joined.kind === "returned" && isChannelOrNull(joined.value)).toBe(true);
}

describe("slack inbound mapper invariants", () => {
  for (const [name, payload] of Object.entries(realPayloads)) {
    it(`hold for a ${name} callback with fields removed or retyped`, async () => {
      await fc.assert(
        fc.asyncProperty(mutatedPayload(payload), fc.boolean(), checkPayload),
        propertyRuns(`slack ${name}`),
      );
    });
  }

  it("hold for a JSON value of any shape", async () => {
    await fc.assert(
      fc.asyncProperty(anyJsonValue, fc.boolean(), checkPayload),
      propertyRuns("slack any JSON"),
    );
  });
});
