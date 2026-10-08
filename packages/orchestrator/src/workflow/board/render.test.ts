import type { PlanEntry } from "@agentclientprotocol/sdk";
import { TASK_STATUSES, type TaskStatus } from "@artfct-ai/contracts/types";
import { describe, expect, it } from "bun:test";
import { BOARD_MAX_ENTRIES, lifecycleLabel, openEntryCount, renderBoard } from "./render";
import type { BoardInput, BoardTask, RefinerPhase, RefinerPhaseView, TodoSnapshot } from "./types";

const NOW = Date.UTC(2026, 8, 4, 0, 7);
const STARTED_AT = "2026-09-03T23:55:00.000Z";

const task: BoardTask = {
  task_id: "wf_abc.2",
  number: 2,
  ticket_key: "ENG-7",
  workflow_name: "Fix the login redirect",
  work: { stage: "implement" },
  status: "working",
  paused: false,
  started_at: STARTED_AT,
};

const entries: PlanEntry[] = [
  { content: "Read the schema", priority: "high", status: "completed" },
  { content: "Add the migration", priority: "high", status: "in_progress" },
  { content: "Wire the query", priority: "medium", status: "pending" },
  { content: "Write tests", priority: "low", status: "pending" },
];

const todos: TodoSnapshot = { entries };

const REFINER_PHASES: RefinerPhase[] = ["review", "polish"];

function boardInput(overrides: Partial<BoardInput> = {}): BoardInput {
  return {
    task,
    todos,
    note: null,
    refiners: null,
    artifact_status: null,
    follow_up: null,
    now: NOW,
    ...overrides,
  };
}

function refinerBoard(
  statuses: Partial<Record<RefinerPhase, PlanEntry["status"]>> = { review: "pending" },
  humans: PlanEntry["status"] = "pending",
): BoardInput["refiners"] {
  const phases: RefinerPhaseView[] = [];
  for (const phase of REFINER_PHASES) {
    const status = statuses[phase];
    if (!status) continue;
    phases.push(
      status === "in_progress"
        ? { phase, status, run: 2, refiner_status: "working", ruling: null }
        : { phase, status },
    );
  }
  return { phases, humans };
}

function openPhase(
  phase: RefinerPhase,
  refiner_status: TaskStatus,
  ruling: "awaited" | "rejected" | null = null,
): BoardInput["refiners"] {
  return {
    phases: [{ phase, status: "in_progress", run: 1, refiner_status, ruling }],
    humans: "pending",
  };
}

function withStatus(status: TaskStatus): BoardTask {
  return { ...task, status };
}

function pendingEntries(count: number): PlanEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    content: `Step ${index + 1}`,
    priority: "medium" as const,
    status: "pending" as const,
  }));
}

function textOf(input: BoardInput): string {
  return renderBoard(input).text;
}

function line(input: BoardInput, index: number): string | undefined {
  return textOf(input).split("\n").at(index);
}

function refinerLines(refiners: BoardInput["refiners"]): string[] {
  return textOf(boardInput({ refiners })).split("\n").slice(-2);
}

describe("renderBoard", () => {
  describe("a working task with a fresh todo list", () => {
    it("renders the board in chat markup", () => {
      expect(textOf(boardInput())).toBe(
        [
          "*Fix the login redirect · implement · ENG-7 · working*",
          "Job 2 · started 23:55 · updated 00:07 UTC",
          "",
          "☑ Read the schema",
          "☐ Add the migration ← working",
          "☐ Wire the query",
          "☐ Write tests",
        ].join("\n"),
      );
    });

    it("keeps the stamp out of the body", () => {
      expect(renderBoard(boardInput()).body).toBe(
        [
          "*Fix the login redirect · implement · ENG-7 · working*",
          "",
          "☑ Read the schema",
          "☐ Add the migration ← working",
          "☐ Wire the query",
          "☐ Write tests",
        ].join("\n"),
      );
    });
  });

  describe("a task with no ticket", () => {
    const noTicket = boardInput({ task: { ...task, ticket_key: null } });

    it("drops the ticket field from the header", () => {
      expect(line(noTicket, 0)).toBe("*Fix the login redirect · implement · working*");
    });
  });

  describe("the same board an hour later", () => {
    const later = boardInput({ now: NOW + 60 * 60_000 });

    it("moves the updated stamp", () => {
      expect(line(later, 1)).toBe("Job 2 · started 23:55 · updated 01:07 UTC");
    });

    it("leaves the body alone, so nothing is written", () => {
      expect(renderBoard(later).body).toBe(renderBoard(boardInput()).body);
    });
  });

  describe("a task the harness said nothing about", () => {
    const fallback = "no todo list reported by the harness yet";

    it("falls back to one line without a todo list", () => {
      expect(line(boardInput({ todos: null }), -1)).toBe(fallback);
    });

    it("falls back to the same line for an empty todo list", () => {
      const empty: TodoSnapshot = { entries: [] };
      expect(line(boardInput({ todos: empty }), -1)).toBe(fallback);
    });

    it("prints the phases instead once it holds an artifact", () => {
      const silent = boardInput({ todos: null, refiners: refinerBoard({ review: "in_progress" }) });
      expect(textOf(silent).split("\n").slice(2)).toEqual([
        "",
        "☐ review ← run 2 · working",
        "☐ Ready for Humans",
      ]);
    });
  });

  describe("a todo list longer than the cap", () => {
    const long: TodoSnapshot = { entries: pendingEntries(12) };
    const lines = textOf(boardInput({ todos: long })).split("\n");
    const listed = lines.filter((text) => text.startsWith("☐ "));

    it("lists BOARD_MAX_ENTRIES entries", () => {
      expect(listed).toHaveLength(BOARD_MAX_ENTRIES);
    });

    it("keeps the head of the list", () => {
      expect(listed[0]).toBe("☐ Step 1");
      expect(listed.at(-1)).toBe("☐ Step 10");
    });

    it("counts the rest on the last line", () => {
      expect(lines.at(-1)).toBe("+2 more");
    });

    it("folds the harness list only, never the phases", () => {
      const withRefiner = textOf(
        boardInput({ todos: long, refiners: refinerBoard({ review: "completed" }, "pending") }),
      );
      expect(withRefiner.split("\n").slice(-2)).toEqual(["☑ review", "☐ Ready for Humans"]);
    });
  });

  describe("the phases of an artifact", () => {
    it("shows no phase and no humans line on a stage that declares no refiners", () => {
      expect(textOf(boardInput())).not.toContain("Ready for Humans");
    });

    it("claims nothing before the first reviewer has read it", () => {
      expect(refinerLines(refinerBoard({ review: "pending" }))).toEqual([
        "☐ review",
        "☐ Ready for Humans",
      ]);
    });

    it("shows review, then polish, with the humans line last", () => {
      const lines = textOf(
        boardInput({
          todos: null,
          refiners: refinerBoard({ review: "completed", polish: "in_progress" }),
        }),
      )
        .split("\n")
        .slice(-3);
      expect(lines).toEqual(["☑ review", "☐ polish ← run 2 · working", "☐ Ready for Humans"]);
    });

    it("prints the open phase in chat markup", () => {
      const lines = textOf(
        boardInput({
          todos: null,
          refiners: refinerBoard({ review: "in_progress", polish: "pending" }),
        }),
      )
        .split("\n")
        .slice(-3);
      expect(lines).toEqual(["☐ review ← run 2 · working", "☐ polish", "☐ Ready for Humans"]);
    });

    it("never names the refiner run on the open phase", () => {
      expect(textOf(boardInput({ refiners: refinerBoard({ review: "in_progress" }) }))).not.toMatch(
        /task \d+ /,
      );
    });

    it("says the open phase is starting the sandbox of its refiner run", () => {
      expect(refinerLines(openPhase("review", "provisioning"))[0]).toBe(
        "☐ review ← run 1 · starting the sandbox",
      );
    });

    it("says the open phase is starting while its refiner run is queued", () => {
      expect(refinerLines(openPhase("polish", "queued"))[0]).toBe("☐ polish ← run 1 · starting");
    });

    it("says a done review left its findings with the author", () => {
      expect(refinerLines(openPhase("review", "done"))).toEqual([
        "☐ review ← run 1 · left findings, now with the author",
        "☐ Ready for Humans",
      ]);
    });

    it("says a done polish is handing the artifact on, not leaving findings", () => {
      expect(refinerLines(openPhase("polish", "done"))).toEqual([
        "☐ polish ← run 1 · handing the artifact on",
        "☐ Ready for Humans",
      ]);
    });

    it("says a judge review waits for a ruling", () => {
      expect(refinerLines(openPhase("review", "done", "awaited"))[0]).toBe(
        "☐ review ← run 1 · waiting for your ruling",
      );
    });

    it("says a judge judge rejected the artifact", () => {
      expect(refinerLines(openPhase("review", "done", "rejected"))[0]).toBe(
        "☐ review ← run 1 · rejected, now with the author",
      );
    });

    it("completes the humans line once the artifact reaches the humans", () => {
      expect(refinerLines(refinerBoard({ review: "completed" }, "completed"))).toEqual([
        "☑ review",
        "☑ Ready for Humans",
      ]);
    });
  });

  describe("a task that ended", () => {
    it("names the open items when it failed", () => {
      const input = boardInput({ task: withStatus("failed") });
      expect(line(input, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · failed, 3 items still open*",
      );
    });

    it("uses the singular for one open item", () => {
      const oneOpen: TodoSnapshot = { entries: entries.slice(0, 2) };
      const input = boardInput({ task: withStatus("cancelled"), todos: oneOpen });
      expect(line(input, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · cancelled, 1 item still open*",
      );
    });

    it("reads plain done when every item is completed", () => {
      const completed: TodoSnapshot = {
        entries: entries.map((entry) => ({ ...entry, status: "completed" as const })),
      };
      const input = boardInput({ task: withStatus("done"), todos: completed });
      expect(line(input, 0)).toBe("*Fix the login redirect · implement · ENG-7 · done*");
    });
  });

  describe("a task whose artifact is under review", () => {
    const reviewed = boardInput({ task: withStatus("in_review"), refiners: refinerBoard() });

    it("reads the lifecycle word of the task row", () => {
      expect(line(reviewed, 0)).toBe("*Fix the login redirect · implement · ENG-7 · in review*");
    });

    it("says the task is starting its sandbox while it provisions", () => {
      const provisioning = { ...reviewed, task: withStatus("provisioning") };
      expect(line(provisioning, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · starting the sandbox*",
      );
    });

    it("reads working again when a review run prompts the author", () => {
      const working = { ...reviewed, task: withStatus("working") };
      expect(line(working, 0)).toBe("*Fix the login redirect · implement · ENG-7 · working*");
    });

    it("says the task is paused when a human pauses it", () => {
      expect(line({ ...reviewed, task: { ...task, paused: true } }, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · paused*",
      );
    });

    it("reads the finished status of a paused task that was cancelled", () => {
      const cancelled = { ...withStatus("cancelled"), paused: true };
      expect(line({ ...reviewed, task: cancelled }, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · cancelled, 3 items still open*",
      );
    });
  });

  describe("a board whose artifact the humans hold", () => {
    const delivered = refinerBoard({ review: "completed", polish: "completed" }, "completed");

    it("reads complete while the task works outside a follow-up", () => {
      const input = boardInput({
        task: withStatus("working"),
        refiners: delivered,
        artifact_status: "ready",
      });
      expect(line(input, 0)).toBe("*Fix the login redirect · implement · ENG-7 · complete*");
    });

    it("reads complete while the task is in review", () => {
      const input = boardInput({
        task: withStatus("in_review"),
        refiners: delivered,
        artifact_status: "ready",
      });
      expect(line(input, 0)).toBe("*Fix the login redirect · implement · ENG-7 · complete*");
    });

    it("reads complete once the host accepted the artifact", () => {
      const input = boardInput({
        task: withStatus("in_review"),
        refiners: delivered,
        artifact_status: "accepted",
      });
      expect(line(input, 0)).toBe("*Fix the login redirect · implement · ENG-7 · complete*");
    });

    it("reads failed when the task failed", () => {
      const input = boardInput({
        task: withStatus("failed"),
        refiners: delivered,
        artifact_status: "ready",
      });
      expect(line(input, 0)).toBe(
        "*Fix the login redirect · implement · ENG-7 · failed, 3 items still open*",
      );
    });

    it("prints no note", () => {
      const input = boardInput({
        refiners: delivered,
        artifact_status: "ready",
        note: "prompt failed: 500",
      });
      expect(textOf(input)).not.toContain("note:");
    });
  });

  describe("a board with a follow-up in progress", () => {
    const followingUp = boardInput({
      task: withStatus("working"),
      todos: { entries: entries.map((entry) => ({ ...entry, status: "completed" })) },
      refiners: refinerBoard({ review: "pending", polish: "pending" }, "pending"),
      artifact_status: "ready",
      follow_up: "in_progress",
      note: "prompt failed: 500",
    });

    it("reads the task's live status in the header", () => {
      expect(line(followingUp, 0)).toBe("*Fix the login redirect · implement · ENG-7 · working*");
    });

    it("prints the note", () => {
      expect(line(followingUp, 2)).toBe("note: prompt failed: 500");
    });

    it("lists the follow-ups after the frozen todo list and before the phases", () => {
      expect(textOf(followingUp).split("\n").slice(-8)).toEqual([
        "☑ Read the schema",
        "☑ Add the migration",
        "☑ Wire the query",
        "☑ Write tests",
        "☐ follow-ups ← working",
        "☐ review",
        "☐ polish",
        "☐ Ready for Humans",
      ]);
    });
  });

  describe("a board after a follow-up the humans hold again", () => {
    const followedUp = boardInput({
      task: withStatus("in_review"),
      refiners: refinerBoard({ review: "completed", polish: "completed" }, "completed"),
      artifact_status: "ready",
      follow_up: "completed",
    });

    it("reads complete", () => {
      expect(line(followedUp, 0)).toBe("*Fix the login redirect · implement · ENG-7 · complete*");
    });

    it("checks the follow-ups line", () => {
      expect(textOf(followedUp).split("\n").slice(-4)).toEqual([
        "☑ follow-ups",
        "☑ review",
        "☑ polish",
        "☑ Ready for Humans",
      ]);
    });
  });

  describe("a board whose artifact is a draft again after a handover", () => {
    const reopened = boardInput({
      task: withStatus("in_review"),
      refiners: refinerBoard({ review: "in_progress", polish: "pending" }, "pending"),
      artifact_status: "drafted",
      note: "prompt failed: 500",
    });

    it("reads the task's live status in the header", () => {
      expect(line(reopened, 0)).toBe("*Fix the login redirect · implement · ENG-7 · in review*");
    });

    it("prints the note", () => {
      expect(line(reopened, 2)).toBe("note: prompt failed: 500");
    });

    it("leaves the humans line unchecked", () => {
      expect(textOf(reopened).split("\n").at(-1)).toBe("☐ Ready for Humans");
    });
  });

  describe("a note on a multi-line failure", () => {
    const note = `prompt failed:\n  harness exited 1\n${"x".repeat(300)}`;
    const noteLine = line(boardInput({ note }), 2);

    it("prints it on its own line, collapsed and clipped", () => {
      expect(noteLine?.startsWith("note: prompt failed: harness exited 1 x")).toBe(true);
      expect(noteLine).toHaveLength("note: ".length + 200);
    });
  });

  describe("entry content with newlines and a long line", () => {
    const messy: TodoSnapshot = {
      entries: [
        { content: "  first\nline\r\n\n  second ", priority: "low", status: "pending" },
        { content: "y".repeat(250), priority: "low", status: "completed" },
      ],
    };
    const lines = textOf(boardInput({ todos: messy })).split("\n");

    it("collapses the newlines", () => {
      expect(lines[3]).toBe("☐ first line second");
    });

    it("clips the long content", () => {
      expect(lines[4]).toBe(`☑ ${"y".repeat(200)}`);
    });
  });

  describe("a todo list and a note that both hold GitHub links", () => {
    const note = "prompt failed, see https://github.com/acme/app/pull/7/checks?merge=1";
    const linked: TodoSnapshot = {
      entries: [
        ...entries,
        { content: "Open https://github.com/acme/app/pull/7", priority: "low", status: "pending" },
      ],
    };

    it("carries no GitHub state for any status", () => {
      for (const status of TASK_STATUSES) {
        const output = textOf(
          boardInput({ task: withStatus(status), todos: linked, note, refiners: refinerBoard() }),
        ).toLowerCase();
        for (const forbidden of ["http", "github", "merge", "check"]) {
          expect(output, `${status} contains ${forbidden}`).not.toContain(forbidden);
        }
      }
    });
  });
});

describe("lifecycleLabel", () => {
  it("maps every status to a reader-facing word", () => {
    const expected: Record<TaskStatus, string> = {
      queued: "starting",
      provisioning: "starting the sandbox",
      working: "working",
      in_review: "in review",
      done: "done",
      failed: "failed",
      cancelled: "cancelled",
    };
    for (const status of TASK_STATUSES) {
      expect(lifecycleLabel(status)).toBe(expected[status]);
    }
  });
});

describe("openEntryCount", () => {
  it("counts nothing without a todo list", () => {
    expect(openEntryCount(null)).toBe(0);
  });

  it("counts the entries that are not completed", () => {
    expect(openEntryCount(todos)).toBe(3);
  });

  it("counts nothing in an empty list", () => {
    expect(openEntryCount({ entries: [] })).toBe(0);
  });
});
