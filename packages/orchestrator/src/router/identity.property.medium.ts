import { FakeCodeHost } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import type { Actor } from "@artfct-ai/contracts/inbound";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Access } from "../config/config";
import { Identity, resolveCodeActor } from "./identity";

const RUNS = 200;
const TRACKER_TEAM = "team-1";
const CHAT_TEAM = "T1";

type LookupOutcome = "answers" | "fails" | "not_connected";

type AccessCase = {
  access: Access;
  source: "tracker" | "chat" | "documents" | "code";
  hasEmail: boolean;
  chatTeam: string | null;
  isTrackerApp: boolean;
  trackerKnowsEmail: boolean;
  trackerMember: boolean;
  trackerLookup: LookupOutcome;
  codeApp: boolean;
  mayPush: boolean;
  codeLookup: LookupOutcome;
};

const lookupOutcome = fc.constantFrom<LookupOutcome>("answers", "fails", "not_connected");

const accessCase: fc.Arbitrary<AccessCase> = fc.record({
  access: fc.record(
    { tracker_team: fc.constant(TRACKER_TEAM), chat_team: fc.constant(CHAT_TEAM) },
    { requiredKeys: [] },
  ),
  source: fc.constantFrom("tracker", "chat", "documents", "code"),
  hasEmail: fc.boolean(),
  chatTeam: fc.constantFrom(CHAT_TEAM, "T2", null),
  isTrackerApp: fc.boolean(),
  trackerKnowsEmail: fc.boolean(),
  trackerMember: fc.boolean(),
  trackerLookup: lookupOutcome,
  codeApp: fc.boolean(),
  mayPush: fc.boolean(),
  codeLookup: lookupOutcome,
});

function inTrackerTeam(scenario: AccessCase): boolean {
  if (!scenario.access.tracker_team) return true;
  return scenario.trackerLookup === "answers" && scenario.trackerMember;
}

function joinsTrackerUserByEmail(scenario: AccessCase): boolean {
  if (!scenario.hasEmail || scenario.trackerLookup !== "answers") return false;
  return scenario.trackerKnowsEmail && inTrackerTeam(scenario);
}

function ruleAdmits(scenario: AccessCase): boolean {
  switch (scenario.source) {
    case "tracker": {
      const isOwnApp = scenario.isTrackerApp && scenario.trackerLookup !== "not_connected";
      return !isOwnApp && inTrackerTeam(scenario);
    }
    case "chat": {
      const { chat_team: chatTeam, tracker_team: trackerTeam } = scenario.access;
      if (chatTeam) return scenario.chatTeam === chatTeam;
      if (!trackerTeam) return true;
      return joinsTrackerUserByEmail(scenario);
    }
    case "documents":
      return joinsTrackerUserByEmail(scenario);
    case "code":
      return scenario.codeApp || (scenario.codeLookup === "answers" && scenario.mayPush);
    default: {
      const unhandled: never = scenario.source;
      throw new Error(`unhandled source ${String(unhandled)}`);
    }
  }
}

function lookupNeededAndFailed(scenario: AccessCase): boolean {
  switch (scenario.source) {
    case "code":
      return !scenario.codeApp && scenario.codeLookup === "fails";
    case "chat":
      return (
        !scenario.access.chat_team &&
        Boolean(scenario.access.tracker_team) &&
        scenario.hasEmail &&
        scenario.trackerLookup === "fails"
      );
    case "documents":
      return scenario.hasEmail && scenario.trackerLookup === "fails";
    case "tracker":
      return Boolean(scenario.access.tracker_team) && scenario.trackerLookup === "fails";
    default: {
      const unhandled: never = scenario.source;
      throw new Error(`unhandled source ${String(unhandled)}`);
    }
  }
}

let runNumber = 0;

async function resolveScenario(scenario: AccessCase): Promise<Actor | null> {
  runNumber += 1;
  const linearUserId = `L${runNumber}`;
  const email = `person${runNumber}@acme.test`;
  const tracker =
    scenario.trackerLookup === "not_connected"
      ? null
      : new FakeTracker({
          appUserId: scenario.isTrackerApp ? linearUserId : `app-${runNumber}`,
          team: { id: TRACKER_TEAM, members: scenario.trackerMember ? [linearUserId] : [] },
          usersByEmail: scenario.trackerKnowsEmail
            ? { [email]: { id: linearUserId, name: "Person" } }
            : {},
          failing: scenario.trackerLookup === "fails",
        });
  const userEmail = scenario.hasEmail ? email : null;
  const identity = new Identity(scenario.access, tracker);
  switch (scenario.source) {
    case "tracker":
      return identity.fromTracker({ id: linearUserId, email: userEmail, name: "Person" });
    case "chat":
      return identity.fromChat({
        id: `U${runNumber}`,
        email: userEmail,
        name: "Person",
        member_of_team: scenario.chatTeam,
      });
    case "documents":
      return identity.fromDocuments({ id: `N${runNumber}`, email: userEmail, name: "Person" });
    case "code": {
      const login = `login-${runNumber}`;
      const code =
        scenario.codeLookup === "not_connected"
          ? null
          : new FakeCodeHost({
              pushers: scenario.mayPush ? [login] : [],
              failing: scenario.codeLookup === "fails",
            });
      return resolveCodeActor(code, { login, repo: "acme/app", app: scenario.codeApp });
    }
    default: {
      const unhandled: never = scenario.source;
      throw new Error(`unhandled source ${String(unhandled)}`);
    }
  }
}

describe("the access rules", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it(
    "resolve an actor exactly when the configured rule admits the user, and refuse on a failed lookup",
    async () => {
      await fc.assert(
        fc.asyncProperty(accessCase, async (scenario) => {
          const actor = await resolveScenario(scenario);
          expect(actor !== null).toBe(ruleAdmits(scenario));
          if (lookupNeededAndFailed(scenario)) expect(actor).toBeNull();
        }),
        propertyRuns("access rules", RUNS),
      );
    },
    propertyTimeoutMs(30_000, RUNS),
  );
});
