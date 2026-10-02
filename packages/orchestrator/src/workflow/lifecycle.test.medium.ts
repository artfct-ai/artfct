import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listBindings } from "../db/bindings";
import { createDb } from "../db/client";
import { type FakeRuntime, seedTask } from "../../test/fake-runtime";
import { freshDurableRuntime } from "../../test/durable-runtime";
import { type Scenario, scenario } from "../../test/scenario";
import { cancelTask, completeJob, failTask, startJob } from "./lifecycle";
import { jobInputKey } from "./store/input-key";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const SECOND_TASK = "wf_x.2";
const PR_URL = "https://github.com/acme/app/pull/1";
const STAGES = ["design", "breakdown", "implement"];
const ISSUE = {
  id: "issue-1",
  key: "ENG-42",
  title: "Fix login",
  team_id: null,
  started: false,
};
const db = createDb(env.DB);

function planned(workflow: FakeRuntime, concurrency = 3): void {
  workflow.patchState({ stages: STAGES, concurrency, status: "running" });
}

function acting<Result>(
  act: (workflow: FakeRuntime) => Promise<Result>,
): Scenario<{ workflow: FakeRuntime; result: Result }> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      await run({ workflow, result: await act(workflow) });
    });
}

describe("completeJob", () => {
  describe("the only job of a workflow with three slots", () => {
    const completed = acting(async (workflow) => {
      planned(workflow);
      const task = seedTask(workflow, {}, { wall_schedule: "w1", keepalive_schedule: "k1" });
      return completeJob(workflow, task, "designed");
    });

    it("reports every slot free", () =>
      completed(({ result }) => {
        expect(result).toEqual({ running: 0, slots: 3 });
      }));

    it("marks the author done and forgets its alarm ids", () =>
      completed(({ workflow }) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "done" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          wall_schedule: null,
          keepalive_schedule: null,
        });
      }));

    it("cancels the wall clock and keepalive alarms", () =>
      completed(({ workflow }) => {
        expect(workflow.cancelled.toSorted()).toEqual(["k1", "w1"]);
      }));

    it("destroys the sandbox", () =>
      completed(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`]);
      }));

    it("leaves the workflow running", () =>
      completed(({ workflow }) => {
        expect(workflow.state.status).toBe("running");
      }));

    it("logs the summary", () =>
      completed(({ workflow }) => {
        expect(workflow.lines).toContain("done: designed");
      }));

    it("posts nothing", () =>
      completed(({ workflow }) => {
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("one of three jobs on a workflow with two slots", () => {
    const completed = acting(async (workflow) => {
      planned(workflow, 2);
      const task = seedTask(workflow, { stage: "implement" });
      seedTask(workflow, { task_id: SECOND_TASK, stage: "implement" });
      seedTask(workflow, { task_id: "wf_x.3", stage: "implement" });
      return completeJob(workflow, task, "done");
    });

    it("counts the jobs still running and reports no free slot", () =>
      completed(({ result }) => {
        expect(result).toEqual({ running: 2, slots: 0 });
      }));

    it("leaves the workflow running", () =>
      completed(({ workflow }) => {
        expect(workflow.state.status).toBe("running");
      }));
  });

  describe("a job completed while the review still held its artifact", () => {
    const completed = acting(async (workflow) => {
      planned(workflow);
      const task = seedTask(workflow, { stage: "implement" });
      workflow.store.upsertArtifact({
        job_id: JOB,
        kind: "pull",
        external_url: PR_URL,
        ref: { kind: "pull", repo: "acme/app", number: 1 },
      });
      return completeJob(workflow, task, "shipped");
    });

    it("closes healthy, since the agent judged the work done", () =>
      completed(({ workflow }) => {
        expect(workflow.posted).toEqual([
          expect.objectContaining({
            type: "artifact_ready",
            text: `The pull request is ready for you: ${PR_URL}`,
          }),
        ]);
      }));

    it("releases the artifact the review was holding", () =>
      completed(({ workflow }) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));
  });
});

describe("cancelTask and failTask", () => {
  describe("a cancelled task with a prompt queued on it", () => {
    const cancelled = scenario(freshDurableRuntime, async (workflow) => {
      const first = seedTask(workflow, {}, { hello_schedule: "h1" });
      seedTask(workflow, { task_id: SECOND_TASK });
      workflow.store.enqueuePrompt(TASK, "pending");
      await cancelTask(workflow, first, "PR closed");
    });

    it("marks the task cancelled and forgets its hello alarm id", () =>
      cancelled((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "cancelled" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ hello_schedule: null });
      }));

    it("cancels the hello alarm", () =>
      cancelled((workflow) => {
        expect(workflow.cancelled).toEqual(["h1"]);
      }));

    it("clears the prompt queue", () =>
      cancelled((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("logs the reason", () =>
      cancelled((workflow) => {
        expect(workflow.lines).toContain("cancelled: PR closed");
      }));

    it("posts nothing", () =>
      cancelled((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("notes the cancellation without a wake", () =>
      cancelled((workflow) => {
        expect(workflow.notes).toEqual([
          {
            text: expect.stringContaining(`Job ${JOB} was cancelled: PR closed`),
            wake: "none",
          },
        ]);
      }));

    describe("and the other task then fails", () => {
      const failed = scenario(cancelled, (workflow) =>
        failTask(workflow, workflow.store.requireTask(SECOND_TASK), "harness died"),
      );

      it("marks the failed task failed", () =>
        failed((workflow) => {
          expect(workflow.store.requireTask(SECOND_TASK).status).toBe("failed");
        }));

      it("posts the failure", () =>
        failed((workflow) => {
          expect(workflow.posted).toEqual([
            { type: "failed", job_id: "wf_x-2", reason: "harness died" },
          ]);
        }));

      it("notes the failure and wakes the agent", () =>
        failed((workflow) => {
          expect(workflow.notes[1]).toEqual({
            text: expect.stringContaining(
              "Job wf_x-2 failed: its author wf_x.2 stopped (harness died)",
            ),
            wake: "task_result",
          });
        }));

      it("destroys the sandbox of both tasks", () =>
        failed((workflow) => {
          expect(workflow.sandboxProvider.calls.toSorted()).toEqual([
            `destroy ${TASK}`,
            "destroy wf_x.2",
          ]);
        }));
    });
  });

  describe("a task whose artifact the review still holds", () => {
    const inReview = scenario(freshDurableRuntime, (workflow) => {
      seedTask(workflow, { stage: "implement" });
      workflow.store.upsertArtifact({
        job_id: JOB,
        kind: "pull",
        external_url: PR_URL,
        ref: { kind: "pull", repo: "acme/app", number: 1 },
      });
    });

    describe("cancelled before the humans hear about the artifact", () => {
      const cancelled = scenario(inReview, (workflow) =>
        cancelTask(workflow, workflow.store.requireTask(TASK), "PR closed"),
      );

      it("releases the artifact the review was holding", () =>
        cancelled((workflow) => {
          expect(workflow.posted).toEqual([
            expect.objectContaining({
              type: "artifact_ready",
              text: expect.stringContaining("cancelled before the review settled (PR closed)"),
            }),
          ]);
        }));
    });

    describe("cancelled after the humans already have the artifact", () => {
      const cancelled = scenario(inReview, async (workflow) => {
        workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
        await cancelTask(workflow, workflow.store.requireTask(TASK), "PR closed");
      });

      it("says nothing about the artifact", () =>
        cancelled((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));
    });
  });

  describe("a task that already finished", () => {
    const lateCalls = scenario(freshDurableRuntime, async (workflow) => {
      const done = seedTask(workflow, { status: "done" });
      await cancelTask(workflow, done, "late");
      await failTask(workflow, done, "late");
    });

    it("keeps the task done", () =>
      lateCalls((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("done");
      }));

    it("queues no note", () =>
      lateCalls((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));

    it("posts nothing", () =>
      lateCalls((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("touches no sandbox", () =>
      lateCalls((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));
  });
});

describe("startJob", () => {
  describe("a stage the config names", () => {
    const started = acting((workflow) => {
      planned(workflow);
      workflow.patchState({
        repo: { full: "acme/app" },
        request: { title: "Fix it", text: "Fix it please", links: [] },
      });
      return startJob(workflow, {
        stage: "implement",
        brief: "Make the test pass.",
        input: { kind: "request", text: "Make the test pass." },
      });
    });

    it("creates a job on that stage with a branch and a brief", () =>
      started(({ result }) => {
        expect(result).toMatchObject({
          job_id: JOB,
          stage: "implement",
          branch: "artfct/wf_x-1-fix-it",
          brief: "Make the test pass.",
        });
      }));

    it("keys the job by the text of its request", () =>
      started(({ result }) => {
        expect(result?.input_key).toBe(
          jobInputKey({ kind: "request", text: "Make the test pass." }),
        );
      }));

    it("creates its queued author task", () =>
      started(({ workflow }) => {
        expect(workflow.store.authorTaskOf(JOB)).toMatchObject({ task_id: TASK, status: "queued" });
      }));

    it("gives the task a sandbox row on the stage's harness", () =>
      started(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          harness: "claude-code",
          generation: 0,
        });
      }));

    it("gives the task a bridge token", () =>
      started(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).bridge_token).toHaveLength(32);
      }));

    it("advances the job and task sequences and keeps the workflow running", () =>
      started(({ workflow }) => {
        expect(workflow.state).toMatchObject({ job_seq: 1, task_seq: 1, status: "running" });
      }));

    it("posts the start", () =>
      started(({ workflow }) => {
        expect(workflow.posted).toEqual([{ type: "started", stage: "implement", job_id: JOB }]);
      }));

    it("schedules provisioning for the task", () =>
      started(({ workflow }) => {
        expect(workflow.alarmsFor("provision").map((alarm) => alarm.payload)).toEqual([
          { task_id: TASK },
        ]);
      }));

    it("binds the branch to the workflow", () =>
      started(async () => {
        const bindings = await listBindings(db);
        expect(bindings.map((row) => [row.source, row.external_id, row.workflow_id])).toEqual([
          ["code_branch", "acme/app:artfct/wf_x-1-fix-it", "wf_x"],
        ]);
      }));
  });

  describe("a job that claims an issue for a request that came from chat", () => {
    const claimed = acting((workflow) => {
      planned(workflow);
      workflow.patchState({ origin: { source: "chat", channel: "C1", thread: "1.2" } });
      return startJob(workflow, {
        stage: "implement",
        brief: "Fix it.",
        input: { kind: "issue", issue: ISSUE },
      });
    });

    it("keys the job by the issue id", () =>
      claimed(({ result }) => {
        expect(result?.input_key).toBe(ISSUE.id);
      }));

    it("records no preceding job", () =>
      claimed(({ result }) => {
        expect(result?.preceding_job_id).toBeNull();
      }));

    it("claims the issue and links the chat thread to it", () =>
      claimed(({ workflow }) => {
        expect(workflow.store.outbox().map((entry) => [entry.kind, entry.payload])).toEqual([
          ["issue_update", { to: "started", delegate: null }],
          ["attach_chat_thread", { channel: "C1", thread: "1.2" }],
        ]);
      }));
  });

  describe("a job that claims an issue for a request that came from the tracker", () => {
    const claimed = acting((workflow) => {
      planned(workflow);
      workflow.patchState({
        origin: { source: "tracker", session_id: "sess-1", issue_id: "issue-1" },
      });
      return startJob(workflow, {
        stage: "implement",
        brief: "Fix it.",
        input: { kind: "issue", issue: ISSUE },
      });
    });

    it("claims the issue and links no thread, since the tracker narrates the work", () =>
      claimed(({ workflow }) => {
        expect(workflow.store.outbox().map((entry) => entry.kind)).toEqual(["issue_update"]);
      }));
  });

  describe("a stage that is not in the workflow definition", () => {
    const refused = acting((workflow) => {
      planned(workflow);
      return startJob(workflow, {
        stage: "nope",
        brief: "x",
        input: { kind: "request", text: "x" },
      });
    });

    it("starts no job", () =>
      refused(({ result }) => {
        expect(result).toBeNull();
      }));

    it("leaves the workflow running", () =>
      refused(({ workflow }) => {
        expect(workflow.state.status).toBe("running");
      }));

    it("writes no task row", () =>
      refused(({ workflow }) => {
        expect(workflow.store.tasks()).toEqual([]);
      }));

    it("logs what it refused", () =>
      refused(({ workflow }) => {
        expect(workflow.lines).toContain(
          "start_job refused: stage nope is not in the workflow definition",
        );
      }));
  });
});
