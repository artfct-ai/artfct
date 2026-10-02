import { describe, expect, it } from "bun:test";
import { isFinishedState, readyIssues, unfinishedBlockers } from "./issues";
import type { StateType, TrackerIssue } from "./types";

function issue(identifier: string, type: StateType, blockers: TrackerIssue["blockers"] = []) {
  return {
    id: identifier.toLowerCase(),
    identifier,
    title: identifier,
    url: `https://linear.app/acme/issue/${identifier}`,
    state: { type, name: type },
    team_id: "team-1",
    labels: [],
    blockers,
  } satisfies TrackerIssue;
}

describe("isFinishedState", () => {
  it("counts a completed state as finished", () => {
    expect(isFinishedState("completed")).toBe(true);
  });

  it("counts a canceled state as finished", () => {
    expect(isFinishedState("canceled")).toBe(true);
  });

  it("does not count a started state as finished", () => {
    expect(isFinishedState("started")).toBe(false);
  });
});

describe("unfinishedBlockers", () => {
  describe("an issue with one completed and one started blocker", () => {
    const blocked = issue("ENG-3", "backlog", [
      { id: "eng-1", identifier: "ENG-1", state: { type: "completed" } },
      { id: "eng-2", identifier: "ENG-2", state: { type: "started" } },
    ]);

    it("keeps only the blocker that is not done", () => {
      expect(unfinishedBlockers(blocked).map((blocker) => blocker.identifier)).toEqual(["ENG-2"]);
    });
  });
});

describe("readyIssues", () => {
  describe("a mix of finished, started and unstarted issues", () => {
    const issues = [
      issue("ENG-1", "completed"),
      issue("ENG-2", "started"),
      issue("ENG-3", "backlog", [
        { id: "eng-1", identifier: "ENG-1", state: { type: "completed" } },
      ]),
      issue("ENG-4", "unstarted", [
        { id: "eng-2", identifier: "ENG-2", state: { type: "started" } },
      ]),
      issue("ENG-5", "unstarted"),
    ];

    it("returns the unstarted issues whose blockers are finished", () => {
      expect(readyIssues(issues).map((ready) => ready.identifier)).toEqual(["ENG-3", "ENG-5"]);
    });
  });
});
