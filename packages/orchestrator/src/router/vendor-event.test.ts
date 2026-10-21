import type { Actor } from "@artfct-ai/contracts/inbound";
import type { IdentityQuery, VendorEvent } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { loadWorkflowDefinition } from "../config/workflow-definition";
import type { TriggerFiring } from "../triggers/types";
import { fireMatchingTriggers, type VendorEventRouter } from "./vendor-event";

const DEFINITION = loadWorkflowDefinition(
  "reviews",
  [
    "description: Review pull requests.",
    "stages:",
    "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
    "triggers:",
    "  - { event: github.pull_request.opened, prompt: Review it. }",
    "  - { event: github.pull_request.opened, filters: { pull_request.draft: [false] }, prompt: Label it. }",
    "  - { event: github.release.published, channel: C1, prompt: Write the notes. }",
  ].join("\n"),
);

const PULL_OPENED: VendorEvent = {
  delivery_id: "d-1",
  name: "github.pull_request.opened",
  payload: { action: "opened", pull_request: { draft: true } },
  causer: { source: "code", user: { login: "octocat", repo: "acme/app", app: false } },
  about_app: false,
  enrichment: { kind: "pull_request", repo: "acme/app", number: 12 },
};

const RELEASED: VendorEvent = {
  delivery_id: "d-2",
  name: "github.release.published",
  payload: { action: "published" },
  causer: { source: "code", user: { login: "octocat", repo: "acme/app", app: false } },
  about_app: false,
};

class ScriptedRouter implements VendorEventRouter {
  readonly definitions = [DEFINITION];
  readonly queries: IdentityQuery[] = [];
  readonly sent: TriggerFiring[][] = [];

  constructor(
    private readonly actor: Actor | null = { email: "octocat@acme.test", display_name: "octocat" },
  ) {}

  resolveActor = async (query: IdentityQuery): Promise<Actor | null> => {
    this.queries.push(query);
    return this.actor;
  };

  sendFirings = async (firings: TriggerFiring[]): Promise<void> => {
    this.sent.push(firings);
  };
}

describe("fireMatchingTriggers", () => {
  it("queues one firing that reports on the pull request for each matching trigger", async () => {
    const router = new ScriptedRouter();
    expect(await fireMatchingTriggers(router, PULL_OPENED)).toEqual({ firings: 1 });
    expect(router.sent).toEqual([
      [
        {
          cause: {
            kind: "vendor_event",
            delivery_id: "d-1",
            event: "github.pull_request.opened",
            payload: '{"action":"opened","pull_request":{"draft":true}}',
          },
          reports: { kind: "pull_request", repo: "acme/app", number: 12 },
          definition: "reviews",
          position: 0,
          attempt: 1,
        },
      ],
    ]);
  });

  it("reports in the trigger's channel for an event that is not about a pull request", async () => {
    const router = new ScriptedRouter();
    await fireMatchingTriggers(router, RELEASED);
    expect(router.sent[0]?.map(({ reports, position }) => ({ reports, position }))).toEqual([
      { reports: { kind: "channel", channel: "C1" }, position: 2 },
    ]);
  });

  it("drops an event that no trigger matches without asking who caused it", async () => {
    const router = new ScriptedRouter();
    const answer = await fireMatchingTriggers(router, { ...RELEASED, name: "github.star.created" });
    expect(answer).toEqual({ dropped: "no trigger matches github.star.created" });
    expect(router.queries).toEqual([]);
    expect(router.sent).toEqual([]);
  });

  it("drops an event whose causer does not pass access", async () => {
    const router = new ScriptedRouter(null);
    expect(await fireMatchingTriggers(router, PULL_OPENED)).toEqual({
      dropped: "the causer is not authorized",
    });
    expect(router.queries).toEqual([PULL_OPENED.causer]);
    expect(router.sent).toEqual([]);
  });
});
