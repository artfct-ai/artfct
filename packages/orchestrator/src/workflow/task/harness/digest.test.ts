import type { PlanEntry } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";
import type { DigestInput, TodoSnapshot } from "../../board/types";
import { DIGEST_MAX_CHARS, taskDigest } from "./digest";

const startedAt = "2026-09-03T10:00:00.000Z";
const minutesLater = (minutes: number): number => Date.parse(startedAt) + minutes * 60_000;

function entry(content: string, status: PlanEntry["status"]): PlanEntry {
  return { content, priority: "medium", status };
}

function todoList(entries: PlanEntry[]): TodoSnapshot {
  return { entries };
}

const workingTodos = todoList([
  entry("Read the brief", "completed"),
  entry("Add the schema", "completed"),
  entry("Write the store", "completed"),
  entry("Write the queries", "completed"),
  entry("Add the tests", "completed"),
  entry("Run the checks", "completed"),
  entry("Wire the reviewer harness", "in_progress"),
  entry("Open the PR", "pending"),
]);

const input: DigestInput = {
  task: {
    task_id: "wf_x.2",
    number: 2,
    ticket_key: "ENG-2",
    workflow_name: "Fix the login redirect",
    work: { stage: "implement" },
    status: "working",
    paused: false,
    started_at: startedAt,
    cost_usd: 0.42,
  },
  artifact: null,
  todos: workingTodos,
  counters: { tool_calls: 34, tool_failures: 2, failed_tools: ["Bash", "Edit"] },
  last: "Tests pass locally.\nOpening the PR next.",
  note: "last prompt failed: boom",
  now: minutesLater(18),
};

function line(digest: string, prefix: string): string | undefined {
  return digest.split("\n").find((candidate) => candidate.startsWith(prefix));
}

function todosLine(todos: DigestInput["todos"]): string | undefined {
  return line(taskDigest({ ...input, todos }), "todos:");
}

function toolsLine(counters: DigestInput["counters"]): string | undefined {
  return line(taskDigest({ ...input, counters }), "tools:");
}

describe("taskDigest", () => {
  describe("a complete input", () => {
    it("renders every line in order", () => {
      expect(taskDigest(input)).toBe(
        [
          "[task wf_x.2 · Fix the login redirect · implement · working]",
          "result: none yet",
          'todos: 6/8 done · now "Wire the reviewer harness"',
          "tools: 34 since the last turn, 2 failed (Bash, Edit)",
          "note: last prompt failed: boom",
          'last: "Tests pass locally. Opening the PR next."',
          "cost: $0.42 · 18 min",
        ].join("\n"),
      );
    });
  });

  describe("a task in review with a pull request", () => {
    const digest = taskDigest({
      ...input,
      task: { ...input.task, status: "in_review" },
      artifact: {
        kind: "pull",
        external_url: "https://github.com/acme/app/pull/7",
        status: "drafted",
      },
    });

    it("renders the lifecycle without underscores", () => {
      expect(line(digest, "[task")).toBe(
        "[task wf_x.2 · Fix the login redirect · implement · in review]",
      );
    });

    it("renders the artifact with its status", () => {
      expect(line(digest, "result:")).toBe(
        "result: pull https://github.com/acme/app/pull/7 status=drafted",
      );
    });
  });

  describe("a workflow with a long name", () => {
    const digest = taskDigest({
      ...input,
      task: { ...input.task, workflow_name: "w".repeat(60) },
      last: "y".repeat(2000),
    });

    it("opens with the whole name", () => {
      expect(line(digest, "[task")).toBe(`[task wf_x.2 · ${"w".repeat(60)} · implement · working]`);
    });

    it("stays within the cap", () => {
      expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    });
  });

  describe("the todos line", () => {
    describe("a harness that reported no todo list", () => {
      it("says none reported", () => {
        expect(todosLine(null)).toBe("todos: none reported by the harness");
      });
    });

    describe("a todo list with no entry in it", () => {
      it("says none reported", () => {
        expect(todosLine(todoList([]))).toBe("todos: none reported by the harness");
      });
    });

    describe("a todo list with every entry completed", () => {
      it("marks it all done", () => {
        const done = todoList([entry("One", "completed"), entry("Two", "completed")]);
        expect(todosLine(done)).toBe("todos: 2/2 done · all done");
      });
    });

    describe("a current step longer than 80 characters", () => {
      it("clips the step", () => {
        const long = todoList([entry("x".repeat(100), "in_progress")]);
        expect(todosLine(long)).toBe(`todos: 0/1 done · now "${"x".repeat(79)}…"`);
      });
    });
  });

  describe("the tools line", () => {
    describe("no tool call since the last turn", () => {
      it("says none", () => {
        expect(toolsLine({ tool_calls: 0, tool_failures: 0, failed_tools: [] })).toBe(
          "tools: none since the last turn",
        );
      });
    });

    describe("tool calls that all passed", () => {
      it("counts the calls", () => {
        expect(toolsLine({ tool_calls: 3, tool_failures: 0, failed_tools: [] })).toBe(
          "tools: 3 since the last turn",
        );
      });
    });

    describe("a failure the harness did not name a tool for", () => {
      it("counts the failure without a name", () => {
        expect(toolsLine({ tool_calls: 3, tool_failures: 1, failed_tools: [] })).toBe(
          "tools: 3 since the last turn, 1 failed",
        );
      });
    });

    describe("more failing tools than the line holds", () => {
      it("names the first five", () => {
        expect(
          toolsLine({
            tool_calls: 9,
            tool_failures: 6,
            failed_tools: ["A", "B", "C", "D", "E", "F"],
          }),
        ).toBe("tools: 9 since the last turn, 6 failed (A, B, C, D, E)");
      });
    });

    describe("one tool that failed twice", () => {
      it("names the tool once", () => {
        expect(
          toolsLine({ tool_calls: 4, tool_failures: 3, failed_tools: ["Bash", "Bash", "Edit"] }),
        ).toBe("tools: 4 since the last turn, 3 failed (Bash, Edit)");
      });
    });
  });

  describe("a turn with no note and no text", () => {
    const digest = taskDigest({ ...input, note: null, last: null });

    it("omits the note line", () => {
      expect(line(digest, "note:")).toBeUndefined();
    });

    it("omits the last line", () => {
      expect(line(digest, "last:")).toBeUndefined();
    });
  });

  describe("a turn whose text is only whitespace", () => {
    it("omits the last line", () => {
      expect(line(taskDigest({ ...input, last: "  \n " }), "last:")).toBeUndefined();
    });
  });

  describe("a note longer than 160 characters", () => {
    it("clips the note", () => {
      const noteLine = line(taskDigest({ ...input, note: "n".repeat(200) }), "note:");
      expect(noteLine).toBe(`note: ${"n".repeat(159)}…`);
    });
  });

  describe("a turn longer than the digest cap", () => {
    const digest = taskDigest({
      ...input,
      last: `${"y".repeat(2000)} opened the pull request`,
    });

    it("fills the digest to the cap", () => {
      expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
      expect(digest.length).toBe(DIGEST_MAX_CHARS);
    });

    it("keeps the end of the turn", () => {
      expect(line(digest, "last:")).toContain("opened the pull request");
    });

    it("marks the dropped head with an ellipsis", () => {
      expect(line(digest, "last:")?.startsWith('last: "…')).toBe(true);
    });

    it("keeps the cost line", () => {
      expect(line(digest, "cost:")).toBe("cost: $0.42 · 18 min");
    });
  });

  describe("a long turn and a long note", () => {
    const digest = taskDigest({ ...input, note: "n".repeat(160), last: "y".repeat(2000) });

    it("stays within the cap", () => {
      expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    });

    it("keeps the last line", () => {
      expect(line(digest, "last:")).toBeDefined();
    });

    describe("and a task id that crowds the other lines out", () => {
      const crowded = taskDigest({
        ...input,
        task: { ...input.task, task_id: "wf_x.2".padEnd(240, "z") },
        note: "n".repeat(160),
        last: "y".repeat(2000),
      });

      it("drops the last line", () => {
        expect(line(crowded, "last:")).toBeUndefined();
      });
    });
  });

  describe("elapsed time", () => {
    describe("a task running for over two hours", () => {
      it("renders hours and minutes", () => {
        expect(line(taskDigest({ ...input, now: minutesLater(125) }), "cost:")).toBe(
          "cost: $0.42 · 2 h 5 min",
        );
      });
    });

    describe("a task running for exactly one hour", () => {
      it("renders the hour with no minutes", () => {
        expect(line(taskDigest({ ...input, now: minutesLater(60) }), "cost:")).toBe(
          "cost: $0.42 · 1 h 0 min",
        );
      });
    });

    describe("a start time that is not a date", () => {
      it("renders 0 min", () => {
        const bogus = taskDigest({ ...input, task: { ...input.task, started_at: "not a date" } });
        expect(line(bogus, "cost:")).toBe("cost: $0.42 · 0 min");
      });
    });

    describe("a start time in the future", () => {
      it("renders 0 min", () => {
        expect(line(taskDigest({ ...input, now: minutesLater(-5) }), "cost:")).toBe(
          "cost: $0.42 · 0 min",
        );
      });
    });
  });

  describe("a task the harness reported no cost for", () => {
    it("says the cost is unknown", () => {
      const unknown = taskDigest({ ...input, task: { ...input.task, cost_usd: 0 } });
      expect(line(unknown, "cost:")).toBe("cost: unknown · 18 min");
    });
  });
});
