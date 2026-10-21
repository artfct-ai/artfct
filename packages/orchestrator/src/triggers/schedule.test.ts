import { describe, expect, it } from "bun:test";
import { loadWorkflowDefinition, type WorkflowDefinition } from "../config/workflow-definition";
import { scheduledFirings, scheduledMinute, scheduleMatches, scheduleProblem } from "./schedule";

function definitionWithSchedules(name: string, schedules: string[]): WorkflowDefinition {
  const triggers = schedules.map(
    (schedule) => `  - { schedule: "${schedule}", channel: C1, prompt: Upgrade the dependencies. }`,
  );
  return loadWorkflowDefinition(
    name,
    [
      "description: Upgrade dependencies.",
      "stages:",
      "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
      "triggers:",
      ...triggers,
    ].join("\n"),
  );
}

const MONDAY_NINE = Date.parse("2026-10-19T09:00:00.000Z");

describe("scheduledMinute", () => {
  it("is the start of the scheduled minute", () => {
    expect(scheduledMinute(MONDAY_NINE + 42_123).toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });
});

describe("scheduleMatches", () => {
  it("reads the expression in UTC", () => {
    expect(scheduleMatches("0 9 * * 1-5", new Date(MONDAY_NINE))).toBe(true);
  });

  it("does not match another hour", () => {
    expect(scheduleMatches("0 9 * * 1-5", new Date(MONDAY_NINE + 3_600_000))).toBe(false);
  });

  it("does not match a weekday outside the list", () => {
    expect(scheduleMatches("0 9 * * 2", new Date(MONDAY_NINE))).toBe(false);
  });
});

describe("scheduleProblem", () => {
  it("accepts five fields", () => {
    expect(scheduleProblem("*/15 * * * *")).toBeNull();
  });

  it("names a field out of range", () => {
    expect(scheduleProblem("61 * * * *")).toContain("minute");
  });

  it("rejects six fields", () => {
    expect(scheduleProblem("0 0 9 * * 1")).not.toBeNull();
  });
});

describe("scheduledFirings", () => {
  const definitions = [
    definitionWithSchedules("dependency-upgrades", ["0 9 * * 1-5", "0 10 * * *"]),
    definitionWithSchedules("weekly-report", ["0 9 * * 1"]),
  ];

  it("fires each trigger whose expression matches the scheduled minute", () => {
    expect(scheduledFirings(definitions, MONDAY_NINE + 59_000)).toEqual([
      {
        cause: { kind: "schedule", minute: "2026-10-19T09:00:00.000Z" },
        reports: { kind: "channel", channel: "C1" },
        definition: "dependency-upgrades",
        position: 0,
        attempt: 1,
      },
      {
        cause: { kind: "schedule", minute: "2026-10-19T09:00:00.000Z" },
        reports: { kind: "channel", channel: "C1" },
        definition: "weekly-report",
        position: 0,
        attempt: 1,
      },
    ]);
  });

  it("names the trigger by its position in its definition", () => {
    const firings = scheduledFirings(definitions, MONDAY_NINE + 3_600_000);
    expect(firings.map(({ definition, position }) => ({ definition, position }))).toEqual([
      { definition: "dependency-upgrades", position: 1 },
    ]);
  });

  it("fires nothing on a minute that no expression matches", () => {
    expect(scheduledFirings(definitions, MONDAY_NINE + 60_000)).toEqual([]);
  });

  it("skips an event trigger", () => {
    const withEvent = loadWorkflowDefinition(
      "release-notes",
      [
        "description: Write release notes.",
        "stages:",
        "  - { name: implement, artifact: pull, branch: true, author: { produce: { execution: harness, skill: implement } } }",
        "triggers:",
        "  - { event: github.release.published, channel: C1, prompt: Write the notes. }",
        '  - { schedule: "0 9 * * 1-5", channel: C1, prompt: Write the notes. }',
      ].join("\n"),
    );
    const firings = scheduledFirings([withEvent], MONDAY_NINE);
    expect(firings.map(({ position }) => position)).toEqual([1]);
  });
});
