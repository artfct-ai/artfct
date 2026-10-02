import { bridgeTokenHeaders } from "@artfct-ai/acp/bridge-token";
import { listDurableObjectIds } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./db/client";
import { saveLinearInstall } from "./db/linear-installs";
import { createWorkflow } from "./db/workflows";

function bridgeUpgrade(workflowId: string): Request {
  return new Request(`https://orchestrator.test/bridge/${workflowId}/${workflowId}.1`, {
    headers: { upgrade: "websocket", ...bridgeTokenHeaders("wrong") },
  });
}

describe("the tracker workspace", () => {
  describe("before the install", () => {
    it("is null", async () => {
      expect(await exports.default.trackerWorkspace()).toBeNull();
    });
  });

  describe("after the install", () => {
    it("is the workspace that installed the app", async () => {
      await saveLinearInstall(createDb(env.DB), {
        organization_id: "org_acme",
        organization_name: "Acme",
        app_user_id: "app1",
        access_token: "lin_oauth_access",
        refresh_token: null,
        expires_at: "2026-10-02T00:00:00.000Z",
        scope: "read,write",
      });
      expect(await exports.default.trackerWorkspace()).toBe("org_acme");
    });
  });
});

describe("the orchestrator entrypoint", () => {
  describe("a bridge upgrade for a workflow that was never created", () => {
    let response: Response;

    beforeEach(async () => {
      response = await exports.default.fetch(bridgeUpgrade("wf_never_created"));
    });

    it("answers 404", () => {
      expect(response.status).toBe(404);
    });

    it("creates no Durable Object", async () => {
      expect(await listDurableObjectIds(env.Workflow)).toEqual([]);
    });
  });

  describe("a bridge upgrade for a workflow that exists", () => {
    let response: Response;

    beforeEach(async () => {
      await createWorkflow(createDb(env.DB), "wf_created");
      response = await exports.default.fetch(bridgeUpgrade("wf_created"));
    });

    it("reaches the Durable Object of that workflow", async () => {
      const ids = await listDurableObjectIds(env.Workflow);
      expect(ids.map(String)).toEqual([String(env.Workflow.idFromName("wf_created"))]);
    });

    it("answers with the socket the Durable Object opened", () => {
      expect(response.status).toBe(101);
    });
  });
});
