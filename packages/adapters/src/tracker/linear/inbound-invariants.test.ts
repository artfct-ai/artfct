import { describe, it } from "bun:test";
import fc from "fast-check";
import { propertyRuns } from "../../../test/property-runs";
import { fakeUserActor } from "../../../test/fake-actors";
import { inboundMapperNeverThrows, mapperOutcome } from "../../../test/inbound-invariants";
import { anyJsonValue, mutatedPayload } from "../../../test/payload-mutations";
import { linearInbound } from "./inbound";
import type { TrackerInboundContext } from "../types";

const WORKSPACE_ID = "org_acme";

const creator = { id: "u1", email: "dev@acme.test", name: "Dev" };

const issue = {
  id: "iss1",
  identifier: "ENG-1",
  title: "Fix login",
  description: "See https://github.com/acme/app",
  url: "https://linear.app/acme/issue/ENG-1/fix-login",
  team: { id: "t1", key: "ENG" },
};

const webhook = { webhookId: "wh1", webhookTimestamp: 1756893600000, organizationId: WORKSPACE_ID };

const realPayloads: Record<string, unknown> = {
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
    data: { id: "cmt3", body: "tighten this", documentContentId: "content1", userId: "u1" },
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

const anyDeliveryId = fc.constantFrom("delivery-1", null);

async function checkPayload(payload: unknown, deliveryId: string | null): Promise<void> {
  const context: TrackerInboundContext = {
    workspaceId: WORKSPACE_ID,
    resolveActor: fakeUserActor(),
    deliveryId,
  };
  inboundMapperNeverThrows(await mapperOutcome(() => linearInbound(payload, context)));
}

describe("linear inbound mapper invariants", () => {
  for (const [name, payload] of Object.entries(realPayloads)) {
    it(`hold for a ${name} webhook with fields removed or retyped`, async () => {
      await fc.assert(
        fc.asyncProperty(mutatedPayload(payload), anyDeliveryId, checkPayload),
        propertyRuns(`linear ${name}`, 100),
      );
    });
  }

  it("hold for a JSON value of any shape", async () => {
    await fc.assert(
      fc.asyncProperty(anyJsonValue, anyDeliveryId, checkPayload),
      propertyRuns("linear any JSON", 100),
    );
  });
});
