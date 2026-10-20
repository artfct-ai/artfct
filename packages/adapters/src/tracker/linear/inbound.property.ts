import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "../../../test/property-runs";
import { recordingUserActor } from "../../../test/fake-actors";
import {
  actorEmailIsLowercase,
  inboundMapperNeverThrows,
  mapperOutcome,
} from "../../../test/inbound-invariants";
import { anyCaseEmail, anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { linearInbound } from "./inbound";
import type { ExternalUser } from "@artfct-ai/contracts/types";
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

function realPayloads(creatorEmail: string | null): Record<string, unknown> {
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

async function checkPayload(payload: unknown, deliveryId: string | null): Promise<void> {
  const asked: ExternalUser[] = [];
  const context: TrackerInboundContext = {
    workspaceId: WORKSPACE_ID,
    resolveActor: recordingUserActor(asked),
    deliveryId,
  };
  inboundMapperNeverThrows(await mapperOutcome(() => linearInbound(payload, context)));
  actorEmailIsLowercase(asked);
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
