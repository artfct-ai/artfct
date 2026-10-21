import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { beforeEach, describe, expect, it } from "bun:test";
import { FakeRuntime } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { sqliteD1 } from "../../../test/sqlite-d1";
import { TEST_DEFINITION_NAME } from "../../../test/test-config";
import { testEnv } from "../../../test/test-env";
import { createDb } from "../../db/client";
import { watcherConversations } from "../../db/watches";
import type { ConversationFiring } from "../../triggers/types";
import { resumeWorkflowEnd } from "../lifecycle";
import { handleEvent } from "./events";
import { fireWorkflow } from "./firing";

const PULL = { repo: "acme/app", number: 12 };

const OPENED: ConversationFiring = {
  firing: {
    cause: {
      kind: "vendor_event",
      delivery_id: "d-1",
      event: "github.pull_request.opened",
      payload: "{}",
    },
    reports: { kind: "pull_request", ...PULL },
    definition: TEST_DEFINITION_NAME,
    position: 1,
    attempt: 1,
  },
  trigger: { event: "github.pull_request.opened", filters: {}, prompt: "Review it." },
  origin: { source: "code", repo: PULL.repo, pull: PULL.number },
};

function pullEvent(id: string, overrides: Partial<InboundEvent>): InboundEvent {
  return {
    id,
    kind: "pr_event",
    actor: null,
    bindings: [{ source: "code_pull", ...PULL }],
    links: [],
    text: "",
    ...overrides,
  };
}

function closed(merged: boolean): InboundEvent {
  return pullEvent(`closed-${merged}`, { pull: { action: "closed", ...PULL, merged } });
}

async function watchingWorkflow(): Promise<FakeRuntime> {
  const workflow = new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: sqliteD1() }, "uncreated");
  workflow.gatewayInstance = new FakeGateway({ decisions: new FakeDecisions({}) });
  await fireWorkflow(workflow, { conversationId: "cv_watcher", firing: OPENED });
  return workflow;
}

describe("a watcher's pull request that merges", () => {
  let workflow: FakeRuntime;

  beforeEach(async () => {
    workflow = await watchingWorkflow();
    await handleEvent(workflow, closed(true));
  });

  it("starts the end of the watcher's workflow as done", () => {
    expect(workflow.store.workflowEnd()?.ends_as).toBe("done");
    expect(workflow.store.requireWorkflowRow().status).toBe("ending");
  });

  it("leaves the rest of the end to its alarm", () => {
    expect(workflow.alarmsFor("resumeWorkflowEnd")).toHaveLength(1);
  });

  it("drops the watch once the alarm goes on with the end", async () => {
    await resumeWorkflowEnd(workflow);
    expect(workflow.store.requireWorkflowRow().status).toBe("ended");
    expect(await watcherConversations(createDb(workflow.env.DB), PULL)).toEqual([]);
  });
});

describe("a watcher's pull request that closes without a merge", () => {
  it("ends the watcher's workflow as cancelled", async () => {
    const workflow = await watchingWorkflow();
    await handleEvent(workflow, closed(false));
    expect(workflow.store.workflowEnd()?.ends_as).toBe("cancelled");
  });
});

describe("a comment on a watcher's pull request", () => {
  it("reaches the agent as a message and keeps the workflow running", async () => {
    const workflow = await watchingWorkflow();
    const comment = pullEvent("comment-1", {
      kind: "feedback",
      actor: { email: "dev@acme.test", display_name: "Dev" },
      text: "Please split this function.",
    });
    await handleEvent(workflow, comment);
    expect(workflow.notes.at(-1)?.text).toContain("Please split this function.");
    expect(workflow.notes.at(-1)?.wake).toBe("message");
    expect(workflow.store.requireWorkflowRow().status).toBe("running");
  });
});

describe("a close of another pull request in a watcher's conversation", () => {
  it("does not end the workflow", async () => {
    const workflow = await watchingWorkflow();
    const other = { repo: "acme/app", number: 13 };
    await handleEvent(
      workflow,
      pullEvent("closed-other", {
        bindings: [{ source: "code_pull", ...other }],
        pull: { action: "closed", ...other, merged: true },
      }),
    );
    expect(workflow.store.workflowEnd()).toBeNull();
  });
});
