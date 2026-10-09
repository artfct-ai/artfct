import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { Delivery } from "@artfct-ai/contracts/types";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindWorkflow, findBinding, listBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { createWorkflow, findWorkflow, setWorkflowStatus } from "../db/workflows";
import { deliver } from "./deliver";

const db = createDb(env.DB);

const prClosed: InboundEvent = {
  id: "evt-pr-closed",
  kind: "pr_event",
  actor: null,
  bindings: [],
  links: [],
  text: "PR closed",
  pull: { repo: "acme/app", number: 7, action: "closed", branch: "artfct/wf_x.1-fix" },
};

const slackStart: InboundEvent = {
  id: "evt-slack-start",
  kind: "start",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [{ source: "chat_thread", external_id: "C1:1.0" }],
  links: [],
  text: "fix the flaky test",
  reply_to: { source: "chat", channel: "C1", thread: "1.0" },
};

const linearStart: InboundEvent = {
  ...slackStart,
  id: "evt-linear-start",
  bindings: [
    { source: "tracker_issue", external_id: "ISS-7" },
    { source: "tracker_session", external_id: "sess-7" },
  ],
  reply_to: { source: "tracker", session_id: "sess-7", issue_id: "ISS-7", team_id: "team-1" },
};

async function stopTurnAndReadLog(workflowId: string): Promise<string[]> {
  const stub = env.Workflow.getByName(workflowId);
  return runInDurableObject(stub, async (workflow) => {
    const dump = (await workflow.debug()) as { log: Array<{ line: string }> };
    await workflow.cancelAllAlarms();
    return dump.log.map((entry) => entry.line);
  });
}

function activities(tracker: FakeTracker): unknown[][] {
  return tracker.argsOf("activity").map(([sessionId, content]) => [sessionId, content]);
}

function spyOnWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

function workflowIdOf(delivery: Delivery): string {
  return (delivery as { workflow_id: string }).workflow_id;
}

describe("an event that binds to nothing and is no start", () => {
  it("drops it, since no workflow waits for it", async () => {
    expect(await deliver(env, prClosed)).toEqual({
      dropped: "no workflow bound for pr_event",
    });
  });

  it("reaches the workflow the branch binding names", async () => {
    await createWorkflow(db, "wf_deliver_run");
    await setWorkflowStatus(db, "wf_deliver_run", "running");
    const bound = { source: "code_branch", repo: "acme/app", branch: "artfct/wf_x-1-fix" } as const;
    await bindWorkflow(db, bound, "wf_deliver_run");
    const delivery = await deliver(env, {
      ...prClosed,
      id: "evt-pr-run",
      bindings: [bound],
    });
    expect(delivery).toEqual({
      workflow_id: "wf_deliver_run",
      created: false,
      joined: false,
      result: { ok: true },
    });
  });
});

describe("deliver to a finished workflow", () => {
  let delivery: Delivery;

  describe("a control event nobody waits on", () => {
    let lines: string[];

    beforeEach(async () => {
      await createWorkflow(db, "wf_bound_done");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-9" }, "wf_bound_done");
      await setWorkflowStatus(db, "wf_bound_done", "done");
      delivery = await deliver(env, {
        ...slackStart,
        id: "evt-late-control",
        kind: "control",
        control: "cancel",
        bindings: [{ source: "tracker_issue", external_id: "ISS-9" }],
        text: "",
        reply_to: undefined,
      });
      lines = await stopTurnAndReadLog("wf_bound_done");
    });

    it("drops it", () => {
      expect(delivery).toEqual({ dropped: "workflow wf_bound_done is done" });
    });

    it("never reaches the Durable Object", () => {
      expect(lines).toEqual([]);
    });
  });

  describe("a prompt from a person", () => {
    let lines: string[];

    beforeEach(async () => {
      await createWorkflow(db, "wf_bound_late");
      await bindWorkflow(db, { source: "chat_thread", external_id: "C2:2.0" }, "wf_bound_late");
      await setWorkflowStatus(db, "wf_bound_late", "done");
      delivery = await deliver(env, {
        ...slackStart,
        id: "evt-late-prompt",
        kind: "prompt",
        bindings: [{ source: "chat_thread", external_id: "C2:2.0" }],
        reply_to: { source: "chat", channel: "C2", thread: "2.0" },
      });
      lines = await stopTurnAndReadLog("wf_bound_late");
    });

    it("drops it", () => {
      expect(delivery).toEqual({ dropped: "workflow wf_bound_late is done" });
    });

    it("never reaches the Durable Object", () => {
      expect(lines).toEqual([]);
    });
  });

  describe("a start in its chat thread", () => {
    let workflowId: string;
    let lines: string[];

    beforeEach(async () => {
      await createWorkflow(db, "wf_thread_done");
      await bindWorkflow(db, { source: "chat_thread", external_id: "C3:3.0" }, "wf_thread_done");
      await setWorkflowStatus(db, "wf_thread_done", "cancelled");
      delivery = await deliver(env, {
        ...slackStart,
        id: "evt-thread-restart",
        bindings: [{ source: "chat_thread", external_id: "C3:3.0" }],
        reply_to: { source: "chat", channel: "C3", thread: "3.0" },
      });
      workflowId = workflowIdOf(delivery);
      lines = await stopTurnAndReadLog("wf_thread_done");
      await stopTurnAndReadLog(workflowId);
    });

    it("creates a new workflow", () => {
      expect(delivery).toMatchObject({ created: true, result: { ok: true } });
      expect(workflowId).not.toBe("wf_thread_done");
    });

    it("binds the thread to the new workflow", async () => {
      expect(await findBinding(db, { source: "chat_thread", external_id: "C3:3.0" })).toBe(
        workflowId,
      );
    });

    it("never reaches the finished Durable Object", () => {
      expect(lines).toEqual([]);
    });
  });
});

describe("deliver a start event", () => {
  let delivery: Delivery;

  describe("a Slack start that binds to nothing", () => {
    let workflowId: string;
    let lines: string[];

    beforeEach(async () => {
      delivery = await deliver(env, slackStart);
      workflowId = workflowIdOf(delivery);
      lines = await stopTurnAndReadLog(workflowId);
    });

    it("creates a workflow and starts the Durable Object", () => {
      expect(delivery).toMatchObject({ created: true, result: { ok: true } });
    });

    it("names it with a workflow id", () => {
      expect(workflowId).toMatch(/^wf_/);
    });

    it("records the workflow as new", async () => {
      expect(await findWorkflow(db, workflowId)).toMatchObject({ status: "new" });
    });

    it("binds the Slack thread to it", async () => {
      expect(await findBinding(db, { source: "chat_thread", external_id: "C1:1.0" })).toBe(
        workflowId,
      );
    });

    it("logs what created it", () => {
      expect(lines[0]).toBe("created from start");
    });

    it("answers a status summary for the workflow, past new", async () => {
      const summary = await env.Workflow.getByName(workflowId).status();
      expect(summary.workflow_id).toBe(workflowId);
      expect(summary.status).not.toBe("new");
    });
  });

  describe("a Slack start whose Durable Object fails to create", () => {
    let failure: unknown;
    let workflowId: string | undefined;

    beforeEach(async () => {
      const getByName = env.Workflow.getByName.bind(env.Workflow);
      const spy = vi.spyOn(env.Workflow, "getByName").mockImplementation((name) => {
        workflowId = name;
        return new Proxy(getByName(name), {
          get: (stub, key) =>
            key === "create"
              ? async () => {
                  throw new Error("Durable Object reset");
                }
              : Reflect.get(stub, key),
        });
      });
      failure = await deliver(env, { ...slackStart, id: "evt-create-fails" }).catch(
        (error: unknown) => error,
      );
      spy.mockRestore();
    });

    it("passes the failure on", () => {
      expect(String(failure)).toContain("Durable Object reset");
    });

    it("leaves the Slack thread bound to nothing", async () => {
      expect(await findBinding(db, { source: "chat_thread", external_id: "C1:1.0" })).toBeNull();
    });

    it("records the workflow as failed", async () => {
      expect(await findWorkflow(db, String(workflowId))).toMatchObject({ status: "failed" });
    });
  });

  describe("a start without an authorized actor", () => {
    beforeEach(async () => {
      delivery = await deliver(env, { ...slackStart, id: "evt-anon", actor: null });
    });

    it("drops it", () => {
      expect(delivery).toEqual({ dropped: "no actor to start a workflow for" });
    });

    it("binds nothing", async () => {
      expect(await listBindings(db)).toEqual([]);
    });
  });

  describe("a start whose bindings reach an existing workflow", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_join");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-1" }, "wf_join");
      delivery = await deliver(env, {
        ...slackStart,
        id: "evt-join",
        bindings: [
          { source: "tracker_issue", external_id: "ISS-1" },
          { source: "chat_thread", external_id: "C9:9.0" },
        ],
      });
    });

    it("joins that workflow", () => {
      expect(delivery).toEqual({
        workflow_id: "wf_join",
        created: false,
        joined: true,
        result: { ok: true },
      });
    });

    it("binds the new Slack thread to it", async () => {
      expect(await findBinding(db, { source: "chat_thread", external_id: "C9:9.0" })).toBe(
        "wf_join",
      );
    });

    describe("and then a prompt that carries another new binding", () => {
      let lines: string[];

      beforeEach(async () => {
        delivery = await deliver(env, {
          ...slackStart,
          id: "evt-prompt",
          kind: "prompt",
          bindings: [
            { source: "tracker_issue", external_id: "ISS-1" },
            { source: "chat_thread", external_id: "C10:10.0" },
          ],
        });
        lines = await stopTurnAndReadLog("wf_join");
      });

      it("reaches the same workflow without joining again", () => {
        expect(delivery).toEqual({
          workflow_id: "wf_join",
          created: false,
          joined: false,
          result: { ok: true },
        });
      });

      it("binds nothing new, since only a start binds", async () => {
        expect(
          await findBinding(db, { source: "chat_thread", external_id: "C10:10.0" }),
        ).toBeNull();
      });

      it("logs the start", () => {
        expect(lines).toContain("event start");
      });

      it("logs the prompt", () => {
        expect(lines).toContain("event prompt");
      });
    });
  });
});

describe("deliver a stop from a session no workflow claimed", () => {
  let tracker: FakeTracker;
  let delivery: Delivery;

  beforeEach(async () => {
    tracker = new FakeTracker();
    delivery = await deliver(env, { ...linearStart, id: "evt-linear-stop", kind: "stop" }, tracker);
  });

  it("drops it", () => {
    expect(delivery).toEqual({ dropped: "no workflow bound for stop" });
  });

  it("posts nothing on the session", () => {
    expect(tracker.calls).toEqual([]);
  });

  it("starts no workflow", async () => {
    expect(await listBindings(db)).toEqual([]);
  });
});

describe("deliver a Linear session start", () => {
  let tracker: FakeTracker;
  let delivery: Delivery;

  beforeEach(() => {
    tracker = new FakeTracker();
  });

  describe("a session with an actor, on an issue no workflow claimed", () => {
    beforeEach(async () => {
      delivery = await deliver(env, linearStart, tracker);
      await stopTurnAndReadLog(workflowIdOf(delivery));
    });

    it("creates the workflow", () => {
      expect(delivery).toMatchObject({ created: true, result: { ok: true } });
    });

    it("tells the session it is on it, before the workflow exists", () => {
      expect(activities(tracker)).toEqual([
        ["sess-7", { type: "thought", body: "On it. Reading the issue." }],
      ]);
    });

    it("posts it as an ephemeral thought that the next activity replaces", () => {
      expect(tracker.argsOf("activity")[0]?.[2]).toEqual({ ephemeral: true });
    });
  });

  describe("a session nobody opened, on an issue no workflow claimed", () => {
    beforeEach(async () => {
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-unowned", actor: null },
        tracker,
      );
    });

    it("drops it", () => {
      expect(delivery).toEqual({ dropped: "no actor to start a workflow for" });
    });

    it("tells the session that no workflow is working on the issue", () => {
      expect(activities(tracker)).toEqual([
        ["sess-7", { type: "thought", body: "On it. Reading the issue." }],
        [
          "sess-7",
          {
            type: "error",
            body: "No workflow is working on this issue. Delegate it to me or mention me to start one.",
          },
        ],
      ]);
    });

    it("binds nothing", async () => {
      expect(await listBindings(db)).toEqual([]);
    });
  });

  describe("a session on an issue a finished workflow claimed", () => {
    let workflowId: string;
    let lines: string[];

    beforeEach(async () => {
      await createWorkflow(db, "wf_linear_done");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-7" }, "wf_linear_done");
      await setWorkflowStatus(db, "wf_linear_done", "done");
      delivery = await deliver(env, { ...linearStart, id: "evt-linear-late" }, tracker);
      workflowId = workflowIdOf(delivery);
      lines = await stopTurnAndReadLog("wf_linear_done");
      await stopTurnAndReadLog(workflowId);
    });

    it("creates a new workflow", () => {
      expect(delivery).toMatchObject({ created: true, result: { ok: true } });
      expect(workflowId).not.toBe("wf_linear_done");
    });

    it("binds the issue and the session to the new workflow", async () => {
      expect(await findBinding(db, { source: "tracker_issue", external_id: "ISS-7" })).toBe(
        workflowId,
      );
      expect(await findBinding(db, { source: "tracker_session", external_id: "sess-7" })).toBe(
        workflowId,
      );
    });

    it("never reaches the finished Durable Object", () => {
      expect(lines).toEqual([]);
    });
  });

  describe("a session nobody opened, on an issue a finished workflow claimed", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_linear_idle");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-7" }, "wf_linear_idle");
      await setWorkflowStatus(db, "wf_linear_idle", "failed");
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-idle", actor: null },
        tracker,
      );
    });

    it("drops it", () => {
      expect(delivery).toEqual({ dropped: "no actor to start a workflow for" });
    });

    it("leaves the issue bound to the finished workflow", async () => {
      expect(await findBinding(db, { source: "tracker_issue", external_id: "ISS-7" })).toBe(
        "wf_linear_idle",
      );
    });
  });

  describe("a session the agent's own delegation opened", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_linear_adopt");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-7" }, "wf_linear_adopt");
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-adopt", actor: null },
        tracker,
      );
      await stopTurnAndReadLog("wf_linear_adopt");
    });

    it("joins the workflow that claimed the issue", () => {
      expect(delivery).toMatchObject({ workflow_id: "wf_linear_adopt", joined: true });
    });

    it("posts only the starting thought on the session", () => {
      expect(activities(tracker)).toEqual([
        ["sess-7", { type: "thought", body: "On it. Reading the issue." }],
      ]);
    });

    it("binds the session to that workflow", async () => {
      expect(await findBinding(db, { source: "tracker_session", external_id: "sess-7" })).toBe(
        "wf_linear_adopt",
      );
    });
  });

  describe("a session on an issue a running workflow claimed", () => {
    beforeEach(async () => {
      await createWorkflow(db, "wf_linear_join");
      await bindWorkflow(db, { source: "tracker_issue", external_id: "ISS-7" }, "wf_linear_join");
      delivery = await deliver(env, { ...linearStart, id: "evt-linear-join" }, tracker);
      await stopTurnAndReadLog("wf_linear_join");
    });

    it("joins it", () => {
      expect(delivery).toMatchObject({ workflow_id: "wf_linear_join", joined: true });
    });

    it("posts only the starting thought on the session", () => {
      expect(activities(tracker).map(([, content]) => content)).toEqual([
        { type: "thought", body: "On it. Reading the issue." },
      ]);
    });
  });

  describe("when the acknowledgement fails", () => {
    let warn: ReturnType<typeof spyOnWarn>;

    beforeEach(async () => {
      warn = spyOnWarn();
      delivery = await deliver(
        env,
        { ...linearStart, id: "evt-linear-down" },
        new FakeTracker({ failing: true }),
      );
      await stopTurnAndReadLog(workflowIdOf(delivery));
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("delivers anyway", () => {
      expect(delivery).toMatchObject({ created: true });
    });

    it("warns which session it could not reach", () => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/tracker ack on session sess-7 failed/),
      );
    });
  });

  describe("without a Linear client", () => {
    beforeEach(async () => {
      delivery = await deliver(env, { ...linearStart, id: "evt-linear-quiet" }, null);
      await stopTurnAndReadLog(workflowIdOf(delivery));
    });

    it("delivers and stays silent", () => {
      expect(delivery).toMatchObject({ created: true });
    });
  });
});

describe("deliver a base branch move", () => {
  describe("a repository where two workflows hold pull requests", () => {
    let delivery: Delivery;

    beforeEach(async () => {
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 1 }, "wf_fan_a");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 2 }, "wf_fan_b");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 3 }, "wf_fan_b");
      await bindWorkflow(db, { source: "code_pull", repo: "acme/other", number: 4 }, "wf_fan_d");
      delivery = await deliver(env, {
        ...prClosed,
        id: "evt-base",
        pull: { repo: "acme/app", action: "base_moved", base: "main" },
      });
    });

    it("fans the event out to each workflow once", () => {
      expect(delivery).toEqual({ fanned_out: 2, results: [{ ok: true }, { ok: true }] });
    });

    it("wakes the first workflow", async () => {
      expect(await stopTurnAndReadLog("wf_fan_a")).toContain("event pr_event");
    });

    it("wakes the second workflow", async () => {
      expect(await stopTurnAndReadLog("wf_fan_b")).toContain("event pr_event");
    });

    it("leaves the workflow in another repository alone", async () => {
      expect(await stopTurnAndReadLog("wf_fan_d")).toEqual([]);
    });
  });
});
