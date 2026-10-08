import type { SessionNotification } from "@agentclientprotocol/sdk";
import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { beforeEach, describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { loggedFailureReason, onSessionUpdate, TurnCoalescer } from "./turn";
import { seedTask } from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";

const TASK = "wf_x.1";

function notice(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "s1", update };
}

describe("onSessionUpdate", () => {
  describe("a tool call", () => {
    const called = scenario(freshRuntime, (workflow) =>
      onSessionUpdate(
        workflow,
        seedTask(workflow),
        notice({
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "Edit file",
          kind: "edit",
          status: "pending",
        }),
      ),
    );

    it("relays the activity as progress", () =>
      called((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "progress", task_id: TASK, text: "edit: Edit file" },
        ]);
      }));

    describe("and a usage update that reports a cost", () => {
      const used = scenario(called, (workflow) =>
        onSessionUpdate(
          workflow,
          workflow.store.requireTask(TASK),
          notice({
            sessionUpdate: "usage_update",
            used: 10,
            size: 100,
            cost: { amount: 0.42, currency: "USD" },
          }),
        ),
      );

      it("stores the cost the harness reported", () =>
        used((workflow) => {
          expect(workflow.store.requireTask(TASK)).toMatchObject({ cost_usd: 0.42 });
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ turn_text: "" });
        }));

      it("posts nothing of its own", () =>
        used((workflow) => {
          expect(workflow.posted).toHaveLength(1);
        }));
    });
  });

  describe("a usage update the harness reports no cost with", () => {
    const used = scenario(freshRuntime, (workflow) =>
      onSessionUpdate(
        workflow,
        seedTask(workflow),
        notice({ sessionUpdate: "usage_update", used: 10, size: 100 }),
      ),
    );

    it("leaves the task cost unknown", () =>
      used((workflow) => {
        expect(workflow.store.requireTask(TASK).cost_usd).toBe(0);
      }));

    it("posts nothing", () =>
      used((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("a todo list update", () => {
    const planned = scenario(freshRuntime, (workflow) => {
      workflow.clock = Date.parse("2026-09-03T10:00:00Z");
      return onSessionUpdate(
        workflow,
        seedTask(workflow),
        notice({
          sessionUpdate: "plan",
          entries: [
            { content: "Read the code", priority: "high", status: "completed" },
            { content: "Write the fix", priority: "high", status: "in_progress" },
          ],
        }),
      );
    });

    it("posts nothing", () =>
      planned((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("stores the list as data", () =>
      planned((workflow) => {
        expect(workflow.store.todoRow(TASK)).toMatchObject({
          flush_schedule: expect.any(String),
          todos: { entries: expect.any(Array) },
        });
      }));

    it("logs how much of the list is open", () =>
      planned((workflow) => {
        expect(workflow.lines).toContain("todo list reported: 1 of 2 open");
      }));

    it("keeps every entry", () =>
      planned((workflow) => {
        expect(workflow.store.todoRow(TASK)?.todos?.entries).toHaveLength(2);
      }));

    it("schedules a board flush for the job", () =>
      planned((workflow) => {
        expect(workflow.alarmsFor("flushBoard")).toMatchObject([
          { delay: 10, payload: { job_id: "wf_x-1" } },
        ]);
      }));
  });

  describe("a tool call that then fails", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      const task = seedTask(workflow);
      await onSessionUpdate(
        workflow,
        task,
        notice({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute" }),
      );
      await onSessionUpdate(
        workflow,
        task,
        notice({
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          title: "bash",
          status: "failed",
        }),
      );
    });

    it("counts the call and the failure for the digest", () =>
      failed((workflow) => {
        expect(workflow.store.todoRow(TASK)).toMatchObject({
          tool_calls: 1,
          tool_failures: 1,
          failed_tools: ["bash"],
        });
      }));
  });

  describe("the todowrite tool call of an opencode task", () => {
    const written = scenario(freshRuntime, (workflow) => {
      workflow.harnessInstance = harnessAdapter("opencode");
      return onSessionUpdate(
        workflow,
        seedTask(workflow, {}, { harness: "opencode" }),
        notice({
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "todowrite",
          kind: "other",
          status: "pending",
          rawInput: {
            todos: [
              { content: "Read the code", status: "completed", priority: "high" },
              { content: "Write the fix", status: "in_progress", priority: "medium" },
            ],
          },
        }),
      );
    });

    it("fills the board from the call", () =>
      written((workflow) => {
        expect(workflow.store.todoRow(TASK)?.todos?.entries).toEqual([
          { content: "Read the code", status: "completed", priority: "high" },
          { content: "Write the fix", status: "in_progress", priority: "medium" },
        ]);
      }));

    it("still counts the call", () =>
      written((workflow) => {
        expect(workflow.store.todoRow(TASK)?.tool_calls).toBe(1);
      }));

    it("still relays the activity as progress", () =>
      written((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "progress", task_id: TASK, text: "other: todowrite" },
        ]);
      }));
  });

  describe("streamed text of a pull request author that prints no link", () => {
    const BRANCH = "artfct/wf_x-1-fix";
    const streamed = scenario(freshRuntime, async (workflow) => {
      workflow.patchState({ repo: { full: "acme/app" } });
      workflow.codeHostInstance = new FakeCodeHost({
        pulls: [pullRequest({ head: { ref: BRANCH, sha: "abc" } })],
      });
      const task = seedTask(workflow, { stage: "implement", branch: BRANCH });
      await onSessionUpdate(workflow, task, notice(textChunk("Pushing ")));
      await onSessionUpdate(workflow, task, notice(textChunk("the fix.")));
    });

    it("does not ask the host about the branch", () =>
      streamed((workflow) => {
        const host = workflow.codeHostInstance;
        expect(host instanceof FakeCodeHost ? host.calls : null).toEqual([]);
      }));

    it("records no artifact yet", () =>
      streamed((workflow) => {
        expect(workflow.store.artifact("wf_x-1")).toBeNull();
      }));
  });
});

function textChunk(text: string): SessionNotification["update"] {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

type Gate = { release: (() => void) | null };

describe("loggedFailureReason", () => {
  it("names what failed and the task whose log holds the details", () => {
    expect(loggedFailureReason("wf_abc.1", "The sandbox start")).toBe(
      "The sandbox start failed. The details are in the logs of task wf_abc.1.",
    );
  });
});

describe("TurnCoalescer", () => {
  let turns: TurnCoalescer;
  let count: number;
  let gate: Gate;

  beforeEach(() => {
    turns = new TurnCoalescer();
    count = 0;
    gate = { release: null };
  });

  function heldTurn(): Promise<void> {
    return turns.run(async () => {
      count += 1;
      if (count === 1) await new Promise<void>((resolve) => (gate.release = resolve));
    });
  }

  describe("wakes that land during a running turn", () => {
    it("absorbs them into one follow-up turn", async () => {
      const first = heldTurn();
      await turns.run(async () => {
        count += 10;
      });
      await turns.run(async () => {
        count += 10;
      });
      gate.release?.();
      await first;
      expect(count).toBe(2);
    });
  });

  describe("idle", () => {
    it("resolves at once when no turn is running", async () => {
      await expect(turns.idle()).resolves.toBeUndefined();
    });

    it("settles when the running turn and its follow-up are done", async () => {
      void heldTurn();
      await turns.run(async () => {
        count += 10;
      });
      const idle = turns.idle();
      gate.release?.();
      await idle;
      expect(count).toBe(2);
    });
  });

  describe("a turn that throws", () => {
    it("rejects every waiter the way the turn did", async () => {
      const failing = turns.run(async () => {
        await Promise.resolve();
        throw new Error("reset");
      });
      const idle = turns.idle();
      await expect(failing).rejects.toThrow("reset");
      await expect(idle).rejects.toThrow("reset");
    });
  });
});
