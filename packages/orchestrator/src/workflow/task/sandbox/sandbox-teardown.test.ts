import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { FakeSandboxProvider } from "../../../../test/fake-sandbox";
import type { SandboxRef } from "../../../sandbox/spec";
import {
  fakeConnection,
  seedTask,
  type FakeRuntime,
  type FakeSocket,
} from "../../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../../test/scenario";
import { clearTaskTimers, destroySandbox } from "./sandbox";

const TASK = "wf_x.1";
const SEEDED_BRIDGE_TOKEN = "tok";

class FailingDestroy extends FakeSandboxProvider {
  override async destroy(sandbox: SandboxRef): Promise<void> {
    await super.destroy(sandbox);
    throw new Error("container gone");
  }
}

describe("clearTaskTimers", () => {
  describe("a task with every timer armed, alongside a second task", () => {
    const cleared = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        {},
        {
          no_progress_schedule: "np",
          wall_schedule: "wall",
          hello_schedule: "hello",
          keepalive_schedule: "keep",
          token_schedule: "token",
        },
      );
      seedTask(workflow, { task_id: "wf_x.2" }, { wall_schedule: "other" });
      await clearTaskTimers(workflow, workflow.store.requireSandbox(TASK));
    });

    it("cancels every alarm of the task", () =>
      cleared((workflow) => {
        expect(workflow.cancelled.toSorted()).toEqual(["hello", "keep", "np", "token", "wall"]);
      }));

    it("forgets the alarm ids on the task", () =>
      cleared((workflow) => {
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          no_progress_schedule: null,
          wall_schedule: null,
          hello_schedule: null,
          keepalive_schedule: null,
          token_schedule: null,
        });
      }));

    it("leaves the other task's alarm alone", () =>
      cleared((workflow) => {
        expect(workflow.store.requireSandbox("wf_x.2").wall_schedule).toBe("other");
      }));
  });
});

type Destroyed = { workflow: FakeRuntime; socket: FakeSocket; other: FakeSocket };

const destroyed: Scenario<Destroyed> = (run) =>
  freshRuntime(async (workflow) => {
    const task = seedTask(workflow);
    workflow.store.enqueuePrompt(TASK, "later");
    workflow.store.enqueuePrompt("wf_x.2", "keep");
    const socket = fakeConnection(TASK, 1);
    const other = fakeConnection("wf_x.2", 1);
    workflow.sockets.push(socket.connection, other.connection);
    await destroySandbox(workflow, task);
    await run({ workflow, socket, other });
  });

describe("destroySandbox", () => {
  describe("a task with a socket and a queued prompt, alongside a second task", () => {
    it("closes the task's socket", () =>
      destroyed(({ socket }) => {
        expect(socket.closes).toEqual([{ code: 1000, reason: "task finished" }]);
      }));

    it("leaves the other task's socket open", () =>
      destroyed(({ other }) => {
        expect(other.closes).toEqual([]);
      }));

    it("drops the task's queued prompts and keeps the other task's", () =>
      destroyed(({ workflow }) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual(["keep"]);
      }));

    it("destroys the container", () =>
      destroyed(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`]);
      }));

    it("replaces the task's bridge token", () =>
      destroyed(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).bridge_token).not.toBe(SEEDED_BRIDGE_TOKEN);
      }));
  });

  describe("a container that will not destroy", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      workflow.sandboxProvider = new FailingDestroy();
      await destroySandbox(workflow, seedTask(workflow));
    });

    it("logs the failure instead of throwing", () =>
      failed((workflow) => {
        expect(workflow.lines).toEqual([expect.stringMatching(/^sandbox destroy failed: /)]);
      }));

    it("logs it against the task", () =>
      failed((workflow) => {
        expect(workflow.store.logLines().map((row) => row.task_id)).toEqual([TASK]);
      }));
  });
});
