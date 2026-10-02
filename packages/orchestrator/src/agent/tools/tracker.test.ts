import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { StateType, TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { seedTask } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { trackerTools } from "./tracker";

const call = { toolCallId: "call-1", messages: [], context: {} };

function issue(
  id: string,
  key: string,
  state: StateType,
  blockers: Array<{ id: string; state: StateType }> = [],
  labels: string[] = [],
): TrackerIssue {
  return {
    id,
    identifier: key,
    title: `Title ${key}`,
    url: `https://tracker.example/acme/issue/${key}`,
    state: { type: state, name: state },
    team_id: null,
    labels,
    blockers: blockers.map((blocker) => ({
      id: blocker.id,
      identifier: blocker.id.toUpperCase(),
      state: { type: blocker.state },
    })),
  };
}

function projectTracker(): FakeTracker {
  return new FakeTracker({
    issues: [
      issue("i1", "ENG-1", "started"),
      issue("i2", "ENG-2", "unstarted", [], ["harness: opencode", "model: claude-sonnet-5"]),
      issue("i3", "ENG-3", "backlog", [{ id: "eng-2", state: "unstarted" }]),
      issue("i4", "ENG-4", "completed"),
      issue("i5", "ENG-5", "unstarted", [{ id: "eng-4", state: "completed" }]),
    ],
  });
}

describe("ready_issues", () => {
  describe("without a tracker client", () => {
    it("says the tracker is not configured", () =>
      freshRuntime(async (workflow) => {
        const { ready_issues } = trackerTools(workflow);
        expect(await ready_issues.execute({ project_id: "proj" }, call)).toBe(
          "The tracker is not configured.",
        );
      }));
  });

  describe("a project with an issue a working task owns and an issue a failed task left free", () => {
    let tracker: FakeTracker;
    let lines: string[];
    const listed = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", issue_id: "i1" });
      seedTask(workflow, { task_id: "wf_x.2", issue_id: "i2", status: "failed" });
      tracker = projectTracker();
      workflow.trackerInstance = tracker;
      const { ready_issues } = trackerTools(workflow);
      lines = toolText(await ready_issues.execute({ project_id: "proj-1" }, call)).split("\n");
    });

    it("lists the ready issues with their labels and the blocked ones, and skips the issue this workflow owns", () =>
      listed(() => {
        expect(lines).toEqual([
          "Open issues not owned by this workflow: 3.",
          "Ready now:",
          "- ENG-2 Title ENG-2 https://tracker.example/acme/issue/ENG-2 labels: harness: opencode, model: claude-sonnet-5",
          "- ENG-5 Title ENG-5 https://tracker.example/acme/issue/ENG-5",
          "Blocked:",
          "- ENG-3 waits for ENG-2",
        ]);
      }));

    it("asks the tracker for the issues of the named project", () =>
      listed(() => {
        expect(tracker.argsOf("projectIssues")).toEqual([["proj-1"]]);
      }));
  });

  describe("a project with an issue whose job a researcher works on", () => {
    let lines: string[];
    const listed = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", issue_id: "i2", role: "researcher" });
      workflow.trackerInstance = projectTracker();
      const { ready_issues } = trackerTools(workflow);
      lines = toolText(await ready_issues.execute({ project_id: "proj-1" }, call)).split("\n");
    });

    it("skips the issue the researcher owns", () =>
      listed(() => {
        expect(lines.filter((line) => line.startsWith("- ENG-2"))).toEqual([]);
      }));
  });
});
