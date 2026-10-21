import { describe, expect, it } from "bun:test";
import { slackVendorEvent } from "@artfct-ai/adapters/chat/slack/vendor-event";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import type { JsonValue } from "@artfct-ai/contracts/types";
import fc from "fast-check";
import { aJoinedChannelIsGreetedUnlessATriggerFires } from "../../test/trigger-matching-invariants";
import { loadWorkflowDefinition } from "../config/workflow-definition";
import type { TriggerFiring } from "../triggers/types";
import { routeVendorEvent, type VendorEventRouter } from "./vendor-event";

const RUNS = 200;

const APP_USER = "UBOT";

const JOIN_TRIGGERS = [
  "{ event: slack.member_joined_channel, filters: { artfct.about_app: [true] }, prompt: Introduce yourself. }",
  "{ event: slack.member_joined_channel, filters: { artfct.about_app: [false] }, prompt: Welcome them. }",
  "{ event: slack.member_joined_channel, prompt: Note the join. }",
  "{ event: slack.member_joined_channel, channel: C7, prompt: Report the join. }",
  "{ event: slack.channel_archive, channel: C7, prompt: Archive the notes. }",
];

function definitionWith(name: string, triggers: string[]) {
  return loadWorkflowDefinition(
    name,
    [
      "description: Onboard a channel.",
      "stages:",
      "  - { name: design, artifact: page, author: { produce: { execution: harness, skill: design } } }",
      ...(triggers.length ? ["triggers:", ...triggers.map((trigger) => `  - ${trigger}`)] : []),
    ].join("\n"),
  );
}

type Join = {
  appJoins: boolean;
  person: string;
  inviter: string | null;
  channel: string;
  definitions: string[][];
  causerPasses: boolean;
};

const join: fc.Arbitrary<Join> = fc.record({
  appJoins: fc.boolean(),
  person: fc.constantFrom("U1", "U2"),
  inviter: fc.option(fc.constantFrom("U1", "U3"), { nil: null }),
  channel: fc.constantFrom("C1", "C2"),
  definitions: fc.array(fc.subarray(JOIN_TRIGGERS, { maxLength: 2 }), { maxLength: 2 }),
  causerPasses: fc.boolean(),
});

/** The Slack callback of the join. The app is always added by an inviter. */
function joinCallback(scenario: Join): JsonValue {
  const inviter = scenario.appJoins ? (scenario.inviter ?? "U1") : scenario.inviter;
  return {
    type: "event_callback",
    event_id: "Ev1",
    authorizations: [{ user_id: APP_USER }],
    event: {
      type: "member_joined_channel",
      user: scenario.appJoins ? APP_USER : scenario.person,
      channel: scenario.channel,
      ...(inviter ? { inviter } : {}),
    },
  };
}

type Reached = { greeted: number; fired: number; refused: number; personJoined: number };

async function checkJoin(scenario: Join, reached: Reached): Promise<void> {
  const firings: TriggerFiring[] = [];
  const greeted: string[] = [];
  const router: VendorEventRouter = {
    definitions: scenario.definitions.map((triggers, index) => {
      return definitionWith(`onboarding-${index}`, triggers);
    }),
    resolveActor: async () => {
      return scenario.causerPasses ? { email: "dev@acme.test", display_name: "Dev" } : null;
    },
    sendFirings: async (sent) => {
      firings.push(...sent);
    },
    greet: async (channel) => {
      greeted.push(channel);
    },
  };
  const passed = slackVendorEvent(joinCallback(scenario));
  if ("event" in passed) await routeVendorEvent(router, passed.event);
  const appJoined = scenario.appJoins ? scenario.channel : null;
  aJoinedChannelIsGreetedUnlessATriggerFires({ appJoined, firings, greeted });
  if (!scenario.appJoins) reached.personJoined += 1;
  else if (firings.length) reached.fired += 1;
  else if (greeted.length) reached.greeted += 1;
  if (scenario.appJoins && !scenario.causerPasses && greeted.length) reached.refused += 1;
}

describe("the greeting of a channel the app joins", () => {
  it(
    "goes out once, unless a trigger fires for the join, and never for a person",
    async () => {
      const reached: Reached = { greeted: 0, fired: 0, refused: 0, personJoined: 0 };
      await fc.assert(
        fc.asyncProperty(join, (scenario) => checkJoin(scenario, reached)),
        propertyRuns("joined channel greeting", RUNS),
      );
      expect(Object.values(reached).every((count) => count > 0)).toBe(true);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
