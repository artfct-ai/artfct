import type { CodeHost } from "@artfct-ai/adapters/code/types";
import type { Documents } from "@artfct-ai/adapters/documents/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { planTools } from "../src/agent/tools/plan";
import type { Workflow } from "../src/workflow";
import { ScriptedFailure } from "./fake-model";
import type { Scenario } from "./scenario";

/** The outside clients a workflow scenario hands the Durable Object before it starts. */
export type WorkflowClients = {
  tracker?: Tracker | null;
  code?: CodeHost | null;
  documents?: Documents | null;
};

const START_EVENT: InboundEvent = {
  id: "evt-start",
  kind: "start",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: ["https://github.com/acme/app"],
  text: "ship it",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

const TOOL_CALL = { toolCallId: "call-1", messages: [], context: {} };

let opened = 0;

/**
 * A real Workflow DO started from a Slack request, with no plan and no alarms pending.
 * `clients` runs before the DO starts. Every call opens a new DO.
 */
export function freshWorkflow(clients: () => WorkflowClients = () => ({})): Scenario<Workflow> {
  return async (run) => {
    opened += 1;
    const name = `wf_fresh_${opened}`;
    const stub = env.Workflow.getByName(name);
    await runInDurableObject(stub, async (workflow: Workflow) => {
      const outside = clients();
      workflow.services.tracker = async () => outside.tracker ?? null;
      workflow.services.code = () => outside.code ?? null;
      if (outside.documents !== undefined)
        workflow.services.documents = async () => outside.documents ?? null;
      workflow.services.model = async () => new ScriptedFailure(["text"]);
      await workflow.create(name, START_EVENT, null);
      await workflow.settle();
      await workflow.cancelAllAlarms();
      try {
        await run(workflow);
      } finally {
        await workflow.cancelAllAlarms();
      }
    });
  };
}

/** A fresh workflow planned for stage implement on acme/app, with `concurrency` slots. */
export function plannedWorkflow(
  concurrency: number,
  clients?: () => WorkflowClients,
): Scenario<Workflow> {
  return (run) =>
    freshWorkflow(clients)(async (workflow) => {
      const { set_plan } = planTools(workflow);
      await set_plan.execute(
        {
          name: "Fix it",
          stages: ["implement"],
          repo: "acme/app",
          page_parent: null,
          reason: "test",
          concurrency,
        },
        TOOL_CALL,
      );
      await run(workflow);
    });
}
