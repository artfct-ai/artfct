import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { recordingUserActor } from "../../../test/fake-actors";
import {
  aConversationalEventNeverFires,
  actorEmailIsLowercase,
  anIgnoredVendorEventNeverFires,
  inboundMapperNeverThrows,
  mapperOutcome,
  type IgnoredVendorEventCause,
} from "../../../test/inbound-invariants";
import { anyCaseEmail, anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { linearConversationalEvents } from "./conversational-events";
import { linearInbound } from "./inbound";
import { linearVendorEvent } from "./vendor-event";
import type { ExternalUser, JsonValue, TrackerInstall } from "@artfct-ai/contracts/types";
import type { TrackerInboundContext } from "../types";

const RUNS = 100;

const WORKSPACE_ID = "org_acme";

const issue = {
  id: "iss1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "See https://github.com/acme/app",
  url: "https://linear.app/acme/issue/ENG-1/fix-login",
  team: { id: "t1", key: "ENG" },
};

const webhook = { webhookId: "wh1", webhookTimestamp: 1756893600000, organizationId: WORKSPACE_ID };

function realPayloads(creatorEmail: string | null): Record<string, Record<string, unknown>> {
  const creator = { id: "u1", email: creatorEmail, name: "Dev" };
  return {
    "AgentSessionEvent/created": {
      ...webhook,
      type: "AgentSessionEvent",
      action: "created",
      agentSession: {
        id: "sess1",
        creator,
        issue,
        comment: { id: "cmt1", body: "@agent please take this" },
      },
      agentActivity: null,
      guidance: "Keep the change small.",
      promptContext: "<issue>ENG-1</issue>",
    },
    "AgentSessionEvent/prompted": {
      ...webhook,
      type: "AgentSessionEvent",
      action: "prompted",
      agentSession: { id: "sess1", creatorId: "u1", issue },
      agentActivity: {
        id: "act1",
        content: { type: "prompt", body: "also add a test" },
        signal: null,
        userId: "u1",
        sourceComment: { id: "cmt2", body: "also add a test", user: creator },
      },
    },
    "Comment/create": {
      ...webhook,
      type: "Comment",
      action: "create",
      data: {
        id: "cmt3",
        body: "tighten this",
        documentContentId: "content1",
        userId: "u1",
        user: creator,
      },
    },
    "Issue/update": {
      ...webhook,
      type: "Issue",
      action: "update",
      data: { id: "iss1", state: { id: "s2", name: "Canceled", type: "canceled" } },
      updatedFrom: { stateId: "s1" },
      actor: creator,
    },
  };
}

const anyDeliveryId = fc.constantFrom("delivery-1", null);

const creatorEmail = fc.option(anyCaseEmail);

const APP_USER_ID = "app_user";

const INSTALL: TrackerInstall = { workspace_id: WORKSPACE_ID, app_user_id: APP_USER_ID };

const personActor = {
  id: "u1",
  type: "user",
  name: "Dev",
  email: "dev@acme.test",
  url: "https://linear.app/acme/profiles/dev",
};

const real = realPayloads("dev@acme.test");

/** A payload of each shape Linear sends, under listed and unlisted names alike. */
const PAYLOADS_BY_SHAPE: Record<string, unknown>[] = [
  real["AgentSessionEvent/created"]!,
  real["AgentSessionEvent/prompted"]!,
  { ...real["AgentSessionEvent/created"], action: "updated" },
  real["Comment/create"]!,
  { ...real["Comment/create"], action: "update" },
  { ...real["Comment/create"], action: "remove" },
  real["Issue/update"]!,
  { ...webhook, type: "Issue", action: "create", data: { id: "iss2", title: "Triage this" } },
  { ...webhook, type: "Project", action: "create", data: { id: "prj1", name: "Q4 launch" } },
  { ...webhook, type: "Cycle", action: "create", data: { id: "cyc1", number: 12 } },
];

/** What a scenario changes in the payload or the install, and why the pass-through must drop it. */
type DropScenario = {
  ignoredBecause: IgnoredVendorEventCause | null;
  organizationId?: string | null;
  install?: null;
  actor?: Record<string, unknown> | null;
};

/** Every way a pass-through must drop an event, and the event it must pass. */
const DROP_SCENARIOS: Record<string, DropScenario> = {
  "a person in the workspace": { ignoredBecause: null },
  "another workspace": { ignoredBecause: "another_workspace", organizationId: "org_other" },
  "a webhook without a workspace": { ignoredBecause: "another_workspace", organizationId: null },
  "a deployment without an install": { ignoredBecause: "another_workspace", install: null },
  "the app user": {
    ignoredBecause: "caused_by_the_app",
    actor: { ...personActor, id: APP_USER_ID },
  },
  "an integration": {
    ignoredBecause: "no_causer",
    actor: { id: "int1", type: "Integration", service: "github" },
  },
  "an OAuth client": {
    ignoredBecause: "no_causer",
    actor: { id: "oc1", type: "OauthClient", name: "Zapier" },
  },
  "an automation without an actor": { ignoredBecause: "no_causer", actor: null },
};

function nameOf(payload: Record<string, unknown>): string {
  return `linear.${String(payload.type)}.${String(payload.action)}`;
}

async function checkPayload(payload: unknown, deliveryId: string | null): Promise<void> {
  const asked: ExternalUser[] = [];
  const context: TrackerInboundContext = {
    workspaceId: WORKSPACE_ID,
    resolveActor: recordingUserActor(asked),
    deliveryId,
  };
  inboundMapperNeverThrows(await mapperOutcome(() => linearInbound(payload, context)));
  actorEmailIsLowercase(asked);
  await linearVendorEvent(payload as JsonValue, { install: INSTALL, deliveryId });
}

async function checkConversational(base: Record<string, unknown>): Promise<void> {
  const payload = { ...base, actor: personActor };
  const name = nameOf(payload);
  const mapped = await linearInbound(payload, {
    workspaceId: WORKSPACE_ID,
    resolveActor: recordingUserActor([]),
    deliveryId: "delivery-1",
  });
  const passed = await linearVendorEvent(payload, {
    install: INSTALL,
    deliveryId: "delivery-1",
  });
  const conversational = (linearConversationalEvents as readonly string[]).includes(name);
  aConversationalEventNeverFires({ step: "mapper", name, conversational, value: mapped });
  aConversationalEventNeverFires({ step: "pass_through", name, conversational, value: passed });
}

async function checkIgnored(base: Record<string, unknown>, scenarioName: string): Promise<void> {
  const scenario = DROP_SCENARIOS[scenarioName]!;
  const payload = {
    ...base,
    organizationId: scenario.organizationId === undefined ? WORKSPACE_ID : scenario.organizationId,
    actor: scenario.actor === undefined ? personActor : scenario.actor,
  };
  const install = scenario.install === undefined ? INSTALL : scenario.install;
  const passed = await linearVendorEvent(payload as JsonValue, { install, deliveryId: null });
  if (scenario.ignoredBecause) anIgnoredVendorEventNeverFires(scenario.ignoredBecause, passed);
}

describe("linear inbound mapper invariants", () => {
  for (const name of Object.keys(realPayloads(null))) {
    const payload = creatorEmail.chain((email) => mutatedPayload(realPayloads(email)[name]));
    it(
      `hold for a ${name} webhook with fields removed or retyped`,
      async () => {
        await fc.assert(
          fc.asyncProperty(payload, anyDeliveryId, checkPayload),
          propertyRuns(`linear ${name}`, RUNS),
        );
      },
      propertyTimeoutMs(5_000, RUNS),
    );
  }

  it(
    "hold for a JSON value of any shape",
    async () => {
      await fc.assert(
        fc.asyncProperty(anyJsonValue, anyDeliveryId, checkPayload),
        propertyRuns("linear any JSON", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});

describe("linear vendor event invariants", () => {
  const listedAndUnlisted = fc.constantFrom(...PAYLOADS_BY_SHAPE);
  const unlisted = fc.constantFrom(
    ...PAYLOADS_BY_SHAPE.filter(
      (payload) => !(linearConversationalEvents as readonly string[]).includes(nameOf(payload)),
    ),
  );
  const scenario = fc.constantFrom(...Object.keys(DROP_SCENARIOS));

  it(
    "hold aConversationalEventNeverFires for every listed and unlisted name",
    async () => {
      await fc.assert(
        fc.asyncProperty(listedAndUnlisted, checkConversational),
        propertyRuns("linear conversational events", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );

  it(
    "hold anIgnoredVendorEventNeverFires for the app, other workspaces and automations",
    async () => {
      await fc.assert(
        fc.asyncProperty(unlisted, scenario, checkIgnored),
        propertyRuns("linear ignored vendor events", RUNS),
      );
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
