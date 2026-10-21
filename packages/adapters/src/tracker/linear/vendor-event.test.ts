import type { JsonValue, TrackerInstall } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { linearVendorEvent } from "./vendor-event";
import { linearVendorEventName } from "./vendor-event-name";

const INSTALL: TrackerInstall = { workspace_id: "org_acme", app_user_id: "app1" };
const dev = { id: "u1", type: "user", name: "Dev", email: "Dev@Acme.test", url: "https://x" };

function projectCreated(fields: Record<string, JsonValue> = {}): JsonValue {
  return {
    type: "Project",
    action: "create",
    organizationId: "org_acme",
    webhookId: "wh1",
    webhookTimestamp: 1756893600000,
    actor: dev,
    data: { id: "prj1", name: "Q4 launch" },
    ...fields,
  };
}

function vendorEvent(payload: JsonValue, install: TrackerInstall | null = INSTALL) {
  return linearVendorEvent(payload, { install, deliveryId: "d-1" });
}

describe("linearVendorEventName", () => {
  it("joins the type and the action in Linear's case", () => {
    expect(linearVendorEventName("Project", "create")).toBe("linear.Project.create");
  });
});

describe("linearVendorEvent", () => {
  it("passes a project a person created, with the person as the causer", async () => {
    const payload = projectCreated();
    expect(await vendorEvent(payload)).toEqual({
      event: {
        delivery_id: "linear:d-1",
        name: "linear.Project.create",
        payload,
        causer: { source: "tracker", user: { id: "u1", email: "dev@acme.test", name: "Dev" } },
        about_app: false,
      },
    });
  });

  it("passes an issue update, which can also cancel the work on its issue", async () => {
    expect(await vendorEvent(projectCreated({ type: "Issue", action: "update" }))).toMatchObject({
      event: { name: "linear.Issue.update" },
    });
  });

  it.each([
    ["AgentSessionEvent", "created"],
    ["AgentSessionEvent", "prompted"],
    ["Comment", "create"],
  ])("drops the conversational event %s.%s", async (type, action) => {
    expect(await vendorEvent(projectCreated({ type, action }))).toEqual({
      drop: "conversational",
    });
  });

  it("drops an event of another workspace", async () => {
    expect(await vendorEvent(projectCreated({ organizationId: "org_other" }))).toEqual({
      drop: "another workspace",
    });
  });

  it("drops every event before the install", async () => {
    expect(await vendorEvent(projectCreated(), null)).toEqual({ drop: "another workspace" });
  });

  it("drops an event the app's own user caused", async () => {
    expect(await vendorEvent(projectCreated({ actor: { ...dev, id: "app1" } }))).toEqual({
      drop: "caused by the app",
    });
  });

  it.each([
    ["an integration", { id: "int1", type: "Integration", service: "github" }],
    ["an OAuth client", { id: "oc1", type: "OauthClient", name: "Zapier" }],
    ["an automation without an actor", null],
  ])("drops an event %s caused", async (_case, actor) => {
    expect(await vendorEvent(projectCreated({ actor }))).toEqual({ drop: "no causer" });
  });

  it("drops a payload that is not a Linear webhook", async () => {
    expect(await vendorEvent({ hello: "world" })).toEqual({ drop: "malformed linear webhook" });
  });

  it("names the delivery by a hash of the webhook when Linear sends no delivery id", async () => {
    const passed = await linearVendorEvent(projectCreated(), {
      install: INSTALL,
      deliveryId: null,
    });
    expect(passed).toMatchObject({ event: { delivery_id: expect.stringMatching(/^linear:wh1:/) } });
  });
});
