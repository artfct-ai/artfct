import { describe, expect, it } from "vitest";
import { afterAppliedEvent } from "../../../test/applied-event";
import { freshDurableRuntime } from "../../../test/durable-runtime";
import { seedTask } from "../../../test/fake-runtime";

describe("applyEvent", () => {
  describe("a cancel with several tasks active", () => {
    const stopped = afterAppliedEvent(freshDurableRuntime, { text: "stop" }, (workflow) => {
      seedTask(workflow);
      seedTask(workflow, { task_id: "wf_x.2" });
    });

    it("handles the event itself, however many tasks are active", () =>
      stopped(({ result }) => {
        expect(result).toBe("handled");
      }));

    it("cancels every task", () =>
      stopped(({ workflow }) => {
        expect(workflow.store.tasks().map((task) => task.status)).toEqual([
          "cancelled",
          "cancelled",
        ]);
      }));

    it("cancels the workflow", () =>
      stopped(({ workflow }) => {
        expect(workflow.state.status).toBe("cancelled");
      }));
  });
});
