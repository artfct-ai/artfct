import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { seedTask } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { taskTools } from "./task";

const call = { toolCallId: "call-1", messages: [], context: {} };

describe("task tools", () => {
  describe("a researcher that still works", () => {
    const researching = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", role: "researcher" });
    });

    it("refuses a cancel and names cancel_job", () =>
      researching(async (workflow) => {
        const { cancel_task } = taskTools(workflow);
        expect(await cancel_task.execute({ task_id: "wf_x.1", reason: "x" }, call)).toBe(
          "Task wf_x.1 is the researcher of job wf_x-1. cancel_job stops the job.",
        );
      }));

    it("refuses a prompt and names cancel_job", () =>
      researching(async (workflow) => {
        const { prompt_task } = taskTools(workflow);
        expect(await prompt_task.execute({ task_id: "wf_x.1", text: "hi" }, call)).toBe(
          "Task wf_x.1 is a researcher. The system runs it end to end. " +
            "You cannot prompt, pause, or resume one. cancel_job stops its job.",
        );
      }));

    it("leaves the researcher working", () =>
      researching(async (workflow) => {
        const { cancel_task } = taskTools(workflow);
        await cancel_task.execute({ task_id: "wf_x.1", reason: "x" }, call);
        expect(workflow.store.requireTask("wf_x.1").status).toBe("working");
      }));
  });

  describe("a task that is done", () => {
    const finished = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", status: "done" });
    });

    it("refuses a prompt for a task id it never saw", () =>
      finished(async (workflow) => {
        const { prompt_task } = taskTools(workflow);
        expect(await prompt_task.execute({ task_id: "wf_x.9", text: "hi" }, call)).toBe(
          "Task wf_x.9 does not exist.",
        );
      }));

    it("refuses a prompt", () =>
      finished(async (workflow) => {
        const { prompt_task } = taskTools(workflow);
        expect(await prompt_task.execute({ task_id: "wf_x.1", text: "hi" }, call)).toBe(
          "Task wf_x.1 is done.",
        );
      }));

    it("refuses a pause", () =>
      finished(async (workflow) => {
        const { pause_task } = taskTools(workflow);
        expect(await pause_task.execute({ task_id: "wf_x.1" }, call)).toBe("Task wf_x.1 is done.");
      }));

    it("refuses a resume", () =>
      finished(async (workflow) => {
        const { resume_task } = taskTools(workflow);
        expect(await resume_task.execute({ task_id: "wf_x.1" }, call)).toBe("Task wf_x.1 is done.");
      }));

    it("refuses a cancel of its author", () =>
      finished(async (workflow) => {
        const { cancel_task } = taskTools(workflow);
        expect(await cancel_task.execute({ task_id: "wf_x.1", reason: "x" }, call)).toBe(
          "Task wf_x.1 is the author of job wf_x-1. cancel_job stops the job.",
        );
      }));

    describe("after all four tools refused", () => {
      const refused = scenario(finished, async (workflow) => {
        const { prompt_task, pause_task, resume_task, cancel_task } = taskTools(workflow);
        await prompt_task.execute({ task_id: "wf_x.1", text: "hi" }, call);
        await pause_task.execute({ task_id: "wf_x.1" }, call);
        await resume_task.execute({ task_id: "wf_x.1" }, call);
        await cancel_task.execute({ task_id: "wf_x.1", reason: "x" }, call);
      });

      it("queues nothing", () =>
        refused((workflow) => {
          expect(workflow.store.queue()).toEqual([]);
        }));

      it("leaves the task done", () =>
        refused((workflow) => {
          expect(workflow.store.requireTask("wf_x.1").status).toBe("done");
        }));
    });
  });

  describe("a reviewer run, which the system runs on its own", () => {
    const refusal =
      "Task wf_x.2 is a reviewer. The system runs it end to end. " +
      "You cannot prompt, pause, or resume one. cancel_task stops it.";
    const review = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.2", role: "reviewer", job_id: "wf_x-1" });
    });

    it("refuses a prompt", () =>
      review(async (workflow) => {
        const { prompt_task } = taskTools(workflow);
        expect(await prompt_task.execute({ task_id: "wf_x.2", text: "hi" }, call)).toBe(refusal);
      }));

    it("refuses a pause", () =>
      review(async (workflow) => {
        const { pause_task } = taskTools(workflow);
        expect(await pause_task.execute({ task_id: "wf_x.2" }, call)).toBe(refusal);
      }));

    it("refuses a resume", () =>
      review(async (workflow) => {
        const { resume_task } = taskTools(workflow);
        expect(await resume_task.execute({ task_id: "wf_x.2" }, call)).toBe(refusal);
      }));

    it("refuses a cancel once the run is done", () =>
      review(async (workflow) => {
        workflow.store.updateTask("wf_x.2", { status: "done" });
        const { cancel_task } = taskTools(workflow);
        expect(await cancel_task.execute({ task_id: "wf_x.2", reason: "x" }, call)).toBe(
          "Task wf_x.2 is done.",
        );
      }));

    describe("after the three tools refused", () => {
      const refused = scenario(review, async (workflow) => {
        const { prompt_task, pause_task, resume_task } = taskTools(workflow);
        await prompt_task.execute({ task_id: "wf_x.2", text: "hi" }, call);
        await pause_task.execute({ task_id: "wf_x.2" }, call);
        await resume_task.execute({ task_id: "wf_x.2" }, call);
      });

      it("queues nothing", () =>
        refused((workflow) => {
          expect(workflow.store.queue()).toEqual([]);
        }));

      it("leaves the task working", () =>
        refused((workflow) => {
          expect(workflow.store.requireTask("wf_x.2").status).toBe("working");
        }));
    });

    describe("a cancel", () => {
      let result: string;
      const cancelled = scenario(review, async (workflow) => {
        const { cancel_task } = taskTools(workflow);
        result = toolText(await cancel_task.execute({ task_id: "wf_x.2", reason: "hung" }, call));
      });

      it("cancels the reviewer", () =>
        cancelled((workflow) => {
          expect(workflow.store.requireTask("wf_x.2").status).toBe("cancelled");
        }));

      it("destroys its sandbox", () =>
        cancelled((workflow) => {
          expect(workflow.sandboxProvider.calls).toContain("destroy wf_x.2");
        }));

      it("says the entry stays open and names the two calls that move the artifact", () =>
        cancelled(() => {
          expect(result).toBe(
            "Cancelled reviewer wf_x.2. Its entry stays open on job wf_x-1. Call request_review to run it again, or finish_review to hand the artifact on without it.",
          );
        }));
    });
  });

  describe("prompt_task on a paused task", () => {
    let result: string;
    const prompted = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { paused_at: "2026-09-03T10:00:00.000Z" });
      const { prompt_task } = taskTools(workflow);
      result = toolText(await prompt_task.execute({ task_id: "wf_x.1", text: "use bun" }, call));
    });

    it("answers that the text is queued", () =>
      prompted(() => {
        expect(result).toBe("Queued for wf_x.1.");
      }));

    it("queues the text for the harness", () =>
      prompted((workflow) => {
        expect(workflow.store.queue().map((item) => [item.task_id, item.text])).toEqual([
          ["wf_x.1", "use bun"],
        ]);
      }));
  });

  describe("a working task whose bridge closed a moment ago", () => {
    const working = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, {}, { session_id: "s1", bridge_closed_at: new Date().toISOString() });
    });

    describe("once pause_task ran", () => {
      let paused: string;
      const afterPause = scenario(working, async (workflow) => {
        const { pause_task } = taskTools(workflow);
        paused = toolText(await pause_task.execute({ task_id: "wf_x.1" }, call));
      });

      it("answers that the task is paused", () =>
        afterPause(() => {
          expect(paused).toBe("Paused wf_x.1.");
        }));

      it("holds the task paused and keeps the status it had", () =>
        afterPause((workflow) => {
          const task = workflow.store.requireTask("wf_x.1");
          expect(task.status).toBe("working");
          expect(task.paused_at).not.toBeNull();
        }));

      describe("and resume_task ran after it", () => {
        let resumed: string;
        const afterResume = scenario(afterPause, async (workflow) => {
          const { resume_task } = taskTools(workflow);
          resumed = toolText(await resume_task.execute({ task_id: "wf_x.1", text: "go on" }, call));
        });

        it("answers that the task is resumed", () =>
          afterResume(() => {
            expect(resumed).toBe("Resumed wf_x.1.");
          }));

        it("releases the hold and leaves the task working", () =>
          afterResume((workflow) => {
            expect(workflow.store.requireTask("wf_x.1")).toMatchObject({
              status: "working",
              paused_at: null,
            });
          }));

        it("queues the text that came with the resume", () =>
          afterResume((workflow) => {
            expect(workflow.store.queue().map((item) => item.text)).toEqual(["go on"]);
          }));

        it("waits for the bridge instead of waking the sandbox", () =>
          afterResume((workflow) => {
            expect(workflow.alarmsFor("retryQueue")).toHaveLength(1);
          }));

        it("tells the channels about both moves", () =>
          afterResume((workflow) => {
            expect(workflow.posted.map((event) => event.type)).toEqual(["info", "info"]);
          }));
      });
    });
  });

  describe("cancel_task on an author task with a queued prompt", () => {
    let result: string;
    const refused = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow);
      workflow.store.enqueuePrompt("wf_x.1", "pending");
      const { cancel_task } = taskTools(workflow);
      result = toolText(
        await cancel_task.execute({ task_id: "wf_x.1", reason: "wrong repo" }, call),
      );
    });

    it("refuses and names cancel_job", () =>
      refused(() => {
        expect(result).toBe("Task wf_x.1 is the author of job wf_x-1. cancel_job stops the job.");
      }));

    it("leaves the task working", () =>
      refused((workflow) => {
        expect(workflow.store.requireTask("wf_x.1").status).toBe("working");
      }));

    it("keeps the queued prompt", () =>
      refused((workflow) => {
        expect(workflow.store.queue().map((item) => item.text)).toEqual(["pending"]);
      }));

    it("keeps the sandbox", () =>
      refused((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));
  });
});
