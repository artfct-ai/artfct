import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import type { z } from "zod";
import {
  patchModelExecution,
  seedModelAuthor,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { readTools } from "./read";

const call = { toolCallId: "call-1", messages: [], context: {} };

function lineSchema(workflow: FakeRuntime): z.ZodType<{ lines: number }> {
  return readTools(workflow).read_log.inputSchema as z.ZodType<{ lines: number }>;
}

describe("read_task", () => {
  it("refuses a task id it never saw", () =>
    freshRuntime(async (workflow) => {
      const { read_task } = readTools(workflow);
      expect(await read_task.execute({ task_id: "wf_x.9" }, call)).toBe(
        "Task wf_x.9 does not exist.",
      );
    }));

  describe("a working task with a prompt in flight and one queued", () => {
    let lines: string[];
    const read = scenario(freshRuntime, async (workflow) => {
      seedTask(
        workflow,
        { issue_key: "ENG-1", summary: "Opened the PR." },
        { prompt_in_flight: 1 },
      );
      workflow.store.enqueuePrompt("wf_x.1", "later");
      const { read_task } = readTools(workflow);
      lines = toolText(await read_task.execute({ task_id: "wf_x.1" }, call)).split("\n");
    });

    it("describes the task with its queue, last output, and unknown cost", () =>
      read(() => {
        expect(lines).toEqual([
          "Task wf_x.1 job=wf_x-1 stage=design role=author issue=ENG-1 status=working harness=opencode model=mock",
          "Branch: none. Cost: unknown. Restarts: 0.",
          "Prompt in flight: yes. Queued prompts: 1.",
          "Last output:",
          "Opened the PR.",
        ]);
      }));
  });

  describe("a task whose harness reported a cost", () => {
    it("shows the cost", () =>
      freshRuntime(async (workflow) => {
        seedTask(workflow, { cost_usd: 0.42 });
        const { read_task } = readTools(workflow);
        expect(toolText(await read_task.execute({ task_id: "wf_x.1" }, call))).toContain(
          "Cost: $0.42.",
        );
      }));
  });
});

describe("read_log", () => {
  describe("five workflow lines and one task line, read two at a time", () => {
    let lines: string[];
    const read = scenario(freshRuntime, async (workflow) => {
      for (let index = 1; index <= 5; index += 1) workflow.log(null, `line ${index}`);
      workflow.log("wf_x.1", "task line");
      const { read_log } = readTools(workflow);
      lines = toolText(await read_log.execute({ lines: 2 }, call)).split("\n");
    });

    it("returns as many lines as it was asked for", () =>
      read(() => {
        expect(lines).toHaveLength(2);
      }));

    it("returns the last lines of the log", () =>
      read(() => {
        expect(lines[0]).toMatch(/ - line 5$/);
      }));

    it("names the task a line belongs to", () =>
      read(() => {
        expect(lines[1]).toMatch(/ wf_x\.1 task line$/);
      }));
  });

  describe("the line count the agent may ask for", () => {
    it("falls back to 40 lines", () =>
      freshRuntime((workflow) => {
        expect(lineSchema(workflow).safeParse({}).data).toEqual({ lines: 40 });
      }));

    it("accepts 200 lines", () =>
      freshRuntime((workflow) => {
        expect(lineSchema(workflow).safeParse({ lines: 200 }).success).toBe(true);
      }));

    it("refuses more than 200 lines", () =>
      freshRuntime((workflow) => {
        expect(lineSchema(workflow).safeParse({ lines: 201 }).success).toBe(false);
      }));
  });
});

describe("read_task on a model-call author", () => {
  it("says the task runs as one model call", () =>
    freshRuntime(async (workflow) => {
      patchModelExecution(workflow);
      seedModelAuthor(workflow);
      const { read_task } = readTools(workflow);
      const lines = toolText(await read_task.execute({ task_id: "wf_x.1" }, call)).split("\n");
      expect(lines.slice(0, 3)).toEqual([
        "Task wf_x.1 job=wf_x-1 stage=design role=author issue=- status=queued execution=model model=openrouter/x-ai/grok-4.6",
        "Branch: none. Cost: unknown. It runs as one model call, with no sandbox.",
        "Queued prompts: 0.",
      ]);
    }));
});
