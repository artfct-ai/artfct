import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bindWorkflow, listBindings } from "../../db/bindings";
import { createDb } from "../../db/client";
import { applyControlWord } from "./controls";
import { type FakeRuntime, seedPullRequestTask, seedTask } from "../../../test/fake-runtime";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { type Scenario, scenario } from "../../../test/scenario";
import { TAG_TO_START_AGAIN } from "../../notify/messages";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const SECOND_TASK = "wf_x.2";
const actor = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };
const db = createDb(env.DB);

function controlEvent(
  word: NonNullable<InboundEvent["control"]>,
  text = "",
  patch: Partial<InboundEvent> = {},
): InboundEvent {
  return {
    id: `evt-${word}`,
    kind: "control",
    actor,
    bindings: [],
    links: [],
    text,
    control: word,
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
    ...patch,
  };
}

function issueEvent(
  word: NonNullable<InboundEvent["control"]>,
  text: string,
  issueId: string,
): InboundEvent {
  return controlEvent(word, text, {
    bindings: [{ source: "tracker_issue", external_id: issueId }],
    reply_to: undefined,
  });
}

function statuses(workflow: FakeRuntime): Array<[string, string]> {
  return workflow.store
    .tasks()
    .map((task): [string, string] => [task.task_id, task.status])
    .toSorted(([first], [second]) => first.localeCompare(second));
}

type Controlled = {
  workflow: FakeRuntime;
  result: Awaited<ReturnType<typeof applyControlWord>>;
};

function controlling(
  arrange: (workflow: FakeRuntime) => void | Promise<void>,
  event: InboundEvent,
): Scenario<Controlled> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      await arrange(workflow);
      await run({ workflow, result: await applyControlWord(workflow, event) });
    });
}

describe("control", () => {
  describe("a control word from a person outside the team", () => {
    const refused = scenario(freshDurableRuntime, async (workflow) => {
      seedTask(workflow);
      await applyControlWord(workflow, controlEvent("cancel", "", { actor: null }));
    });

    it("says it is not authorized", () =>
      refused((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: "Not authorized." }]);
      }));

    it("leaves the task working", () =>
      refused((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("working");
      }));

    it("leaves the workflow running", () =>
      refused((workflow) => {
        expect(workflow.state.status).toBe("running");
      }));
  });

  describe("cancel", () => {
    describe("from a Slack thread, with two active tasks and one done task", () => {
      const cancelled = scenario(freshDurableRuntime, async (workflow) => {
        seedTask(workflow, {}, { wall_schedule: "w1" });
        seedTask(workflow, { task_id: SECOND_TASK }, { keepalive_schedule: "k1" });
        seedTask(workflow, { task_id: "wf_x.3", status: "done" });
        await applyControlWord(workflow, controlEvent("cancel"));
      });

      it("cancels the active tasks and leaves the done one", () =>
        cancelled((workflow) => {
          expect(statuses(workflow)).toEqual([
            [TASK, "cancelled"],
            [SECOND_TASK, "cancelled"],
            ["wf_x.3", "done"],
          ]);
        }));

      it("cancels the alarms of the active tasks", () =>
        cancelled((workflow) => {
          expect(workflow.cancelled.toSorted()).toEqual(["k1", "w1"]);
        }));

      it("destroys the sandbox of the active tasks", () =>
        cancelled((workflow) => {
          expect(workflow.sandboxProvider.calls.toSorted()).toEqual([
            `destroy ${TASK}`,
            "destroy wf_x.2",
          ]);
        }));

      it("closes the workflow", () =>
        cancelled((workflow) => {
          expect(workflow.state.status).toBe("cancelled");
        }));

      it("says the workflow is cancelled", () =>
        cancelled((workflow) => {
          expect(workflow.posted).toEqual([
            { type: "info", text: `Cancelled. ${TAG_TO_START_AGAIN}` },
          ]);
        }));

      it("notes each cancelled task without a wake", () =>
        cancelled((workflow) => {
          expect(workflow.notes.map((note) => note.wake)).toEqual(["none", "none"]);
        }));

      it("names the person who cancelled in the note", () =>
        cancelled((workflow) => {
          expect(workflow.noteTexts()[0]).toContain("was cancelled: Cancelled by Dev.");
        }));
    });

    describe("with a binding of every kind on the workflow", () => {
      const cancelled = controlling(async (workflow) => {
        await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 1 }, "wf_x");
        await bindWorkflow(db, { source: "code_branch", repo: "acme/app", branch: "b" }, "wf_x");
        await bindWorkflow(db, { source: "tracker_issue", external_id: "iss1" }, "wf_x");
        await bindWorkflow(db, { source: "code_pull", repo: "acme/app", number: 2 }, "wf_other");
        seedTask(workflow);
      }, controlEvent("cancel"));

      it("refuses nothing", () =>
        cancelled(({ result }) => {
          expect(result).toBeNull();
        }));

      it("drops the GitHub bindings and keeps the rest", () =>
        cancelled(async () => {
          const rows = await listBindings(db);
          expect(rows.map((row) => `${row.source}:${row.workflow_id}`).toSorted()).toEqual([
            "code_pull:wf_other",
            "tracker_issue:wf_x",
          ]);
        }));
    });

    describe("from a tracker issue whose artifact is accepted", () => {
      const ignored = controlling(
        (workflow) => {
          seedPullRequestTask(
            workflow,
            { issue_id: "iss1", issue_key: "ENG-1" },
            { status: "accepted" },
          );
        },
        issueEvent("cancel", "Issue moved to Done", "iss1"),
      );

      it("refuses with the accepted artifact as the reason", () =>
        ignored(({ result }) => {
          expect(result).toBe("the artifact of job wf_x-1 is accepted");
        }));

      it("leaves the task working", () =>
        ignored(({ workflow }) => {
          expect(workflow.store.requireTask(TASK).status).toBe("working");
        }));

      it("leaves the workflow open", () =>
        ignored(({ workflow }) => {
          expect(workflow.state.status).not.toBe("cancelled");
        }));

      it("posts nothing", () =>
        ignored(({ workflow }) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("logs what it ignored and why", () =>
        ignored(({ workflow }) => {
          expect(workflow.lines).toContain(
            "cancel ignored: the artifact of job wf_x-1 is accepted (Cancelled by Dev. Issue moved to Done)",
          );
        }));
    });

    describe("from a Linear issue one of two tasks works on", () => {
      const cancelled = controlling(
        (workflow) => {
          seedTask(workflow, { issue_id: "iss1", issue_key: "ENG-1" });
          seedTask(workflow, { task_id: SECOND_TASK, issue_id: "iss2", issue_key: "ENG-2" });
        },
        issueEvent("cancel", "Issue moved to Canceled", "iss2"),
      );

      it("cancels the task of that issue", () =>
        cancelled(({ workflow }) => {
          expect(workflow.store.requireTask(SECOND_TASK).status).toBe("cancelled");
        }));

      it("leaves the other task working", () =>
        cancelled(({ workflow }) => {
          expect(workflow.store.requireTask(TASK).status).toBe("working");
        }));

      it("leaves the workflow open", () =>
        cancelled(({ workflow }) => {
          expect(workflow.state.status).not.toBe("cancelled");
        }));

      it("destroys the sandbox of that task alone", () =>
        cancelled(({ workflow }) => {
          expect(workflow.sandboxProvider.calls).toEqual(["destroy wf_x.2"]);
        }));

      it("says nothing in the channel", () =>
        cancelled(({ workflow }) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("logs the cancelled task and its reason", () =>
        cancelled(({ workflow }) => {
          expect(workflow.lines).toContain("cancelled: Cancelled by Dev. Issue moved to Canceled");
        }));
    });

    describe("from the issue the workflow was started on", () => {
      const cancelled = controlling(
        (workflow) => {
          workflow.patchState({
            origin: { source: "tracker", session_id: "sess", issue_id: "iss1", team_id: "team" },
          });
          seedTask(workflow, { issue_id: "iss1", issue_key: "ENG-1" });
          seedTask(workflow, { task_id: SECOND_TASK, issue_id: "iss2", issue_key: "ENG-2" });
        },
        issueEvent("cancel", "Issue moved to Done", "iss1"),
      );

      it("cancels the task of that issue", () =>
        cancelled(({ workflow }) => {
          expect(workflow.store.requireTask(TASK).status).toBe("cancelled");
        }));

      it("cancels the task of every other issue too", () =>
        cancelled(({ workflow }) => {
          expect(workflow.store.requireTask(SECOND_TASK).status).toBe("cancelled");
        }));

      it("closes the workflow", () =>
        cancelled(({ workflow }) => {
          expect(workflow.state.status).toBe("cancelled");
        }));

      it("names the person and the reason in the note", () =>
        cancelled(({ workflow }) => {
          expect(workflow.noteTexts()[0]).toContain("Cancelled by Dev. Issue moved to Done");
        }));
    });

    describe("with a review task whose parent no longer points at it", () => {
      const cancelled = scenario(freshDurableRuntime, async (workflow) => {
        seedTask(workflow);
        seedTask(workflow, { task_id: SECOND_TASK, role: "reviewer", job_id: JOB });
        await applyControlWord(workflow, controlEvent("cancel"));
      });

      it("reaches the review task", () =>
        cancelled((workflow) => {
          expect(workflow.store.requireTask(SECOND_TASK).status).toBe("cancelled");
        }));

      it("leaves no review task active", () =>
        cancelled((workflow) => {
          expect(workflow.store.activeRefinerRuns()).toEqual([]);
        }));

      it("destroys the sandbox of the review task", () =>
        cancelled((workflow) => {
          expect(workflow.sandboxProvider.calls).toContain("destroy wf_x.2");
        }));
    });

    describe("with a polisher holding the artifact and a prompt queued on the author", () => {
      const cancelled = scenario(freshDurableRuntime, async (workflow) => {
        seedPullRequestTask(workflow, {}, { refiner_task_id: SECOND_TASK });
        seedTask(workflow, {
          task_id: SECOND_TASK,
          role: "polisher",
          refiner_index: 1,
          job_id: JOB,
          stage: "implement",
        });
        workflow.store.enqueuePrompt(TASK, "CI went red.");
        await applyControlWord(workflow, controlEvent("cancel"));
      });

      it("cancels the polisher", () =>
        cancelled((workflow) => {
          expect(workflow.store.requireTask(SECOND_TASK).status).toBe("cancelled");
        }));

      it("starts no sandbox for the author it is cancelling", () =>
        cancelled((workflow) => {
          expect(workflow.sandboxProvider.calls).not.toContain(`start ${TASK}`);
        }));

      it("drops the queued prompt instead of running it", () =>
        cancelled((workflow) => {
          expect(workflow.store.peekPrompt(TASK)).toBeNull();
        }));

      it("gives the humans the artifact with the cancel reason", () =>
        cancelled((workflow) => {
          const announced = workflow.posted.find((event) => event.type === "artifact_ready");
          expect(announced?.type === "artifact_ready" ? announced.text : "").toContain(
            "The job was cancelled before the review settled (Cancelled by Dev.)",
          );
        }));
    });
  });
});
