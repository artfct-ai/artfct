import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { StateType, TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { seedTask } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { SET_SUBJECT_FIRST } from "../../workflow/subject";
import { trackerTools } from "./tracker";

const call = { toolCallId: "call-1", messages: [], context: {} };

type IssueFields = {
  blockers?: Array<{ id: string; state: StateType }>;
  labels?: string[];
  parent?: string;
  project?: string;
};

function issue(id: string, key: string, state: StateType, fields: IssueFields = {}): TrackerIssue {
  return {
    id,
    identifier: key,
    title: `Title ${key}`,
    url: `https://tracker.example/acme/issue/${key}`,
    state: { type: state, name: state },
    team_id: null,
    parent_id: fields.parent ?? null,
    project_id: fields.project ?? "proj-1",
    labels: fields.labels ?? [],
    blockers: (fields.blockers ?? []).map((blocker) => ({
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
      issue("i2", "ENG-2", "unstarted", {
        labels: ["harness: opencode", "model: claude-sonnet-5"],
      }),
      issue("i3", "ENG-3", "backlog", { blockers: [{ id: "eng-2", state: "unstarted" }] }),
      issue("i4", "ENG-4", "completed"),
      issue("i5", "ENG-5", "unstarted", { blockers: [{ id: "eng-4", state: "completed" }] }),
      issue("i6", "ENG-6", "unstarted", { project: "proj-2" }),
    ],
  });
}

describe("ready_issues", () => {
  describe("without a tracker client", () => {
    it("says the tracker is not configured", () =>
      freshRuntime(async (workflow) => {
        const { ready_issues } = trackerTools(workflow);
        expect(await ready_issues.execute({}, call)).toBe("The tracker is not configured.");
      }));
  });

  describe("a workflow without a subject", () => {
    it("says how to set one", () =>
      freshRuntime(async (workflow) => {
        workflow.trackerInstance = projectTracker();
        const { ready_issues } = trackerTools(workflow);
        expect(await ready_issues.execute({}, call)).toBe(
          `This workflow does not have a subject yet. ${SET_SUBJECT_FIRST}`,
        );
      }));
  });

  describe("a project subject with an issue a working task owns and an issue a failed task left free", () => {
    let tracker: FakeTracker;
    let lines: string[];
    const listed = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", issue_id: "i1" });
      seedTask(workflow, { task_id: "wf_x.2", issue_id: "i2", status: "failed" });
      tracker = projectTracker();
      workflow.trackerInstance = tracker;
      workflow.patchState({ subject: { kind: "project", project_id: "proj-1" } });
      const { ready_issues } = trackerTools(workflow);
      lines = toolText(await ready_issues.execute({}, call)).split("\n");
    });

    it("lists the ready issues of the project with their labels and the blocked ones, and skips the issue this workflow owns", () =>
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

    it("asks the tracker for the issues of the subject project", () =>
      listed(() => {
        expect(tracker.argsOf("projectIssues")).toEqual([["proj-1"]]);
      }));
  });

  describe("an issue subject with sub-issues", () => {
    let tracker: FakeTracker;
    let lines: string[];
    const listed = scenario(freshRuntime, async (workflow) => {
      tracker = new FakeTracker({
        issues: [
          issue("i10", "ENG-10", "unstarted"),
          issue("i11", "ENG-11", "unstarted", { parent: "i10" }),
          issue("i12", "ENG-12", "unstarted", { parent: "i11" }),
          issue("i13", "ENG-13", "unstarted"),
        ],
      });
      workflow.trackerInstance = tracker;
      workflow.patchState({ subject: { kind: "issue", issue_id: "i10" } });
      const { ready_issues } = trackerTools(workflow);
      lines = toolText(await ready_issues.execute({}, call)).split("\n");
    });

    it("lists the subject issue and its direct sub-issues only", () =>
      listed(() => {
        expect(lines).toEqual([
          "Open issues not owned by this workflow: 2.",
          "Ready now:",
          "- ENG-10 Title ENG-10 https://tracker.example/acme/issue/ENG-10",
          "- ENG-11 Title ENG-11 https://tracker.example/acme/issue/ENG-11",
        ]);
      }));

    it("asks the tracker for the subject issue and its sub-issues", () =>
      listed(() => {
        expect([tracker.argsOf("issue"), tracker.argsOf("subIssues")]).toEqual([
          [["i10"]],
          [["i10"]],
        ]);
      }));
  });

  describe("a project subject with an issue whose job a researcher works on", () => {
    let lines: string[];
    const listed = scenario(freshRuntime, async (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", issue_id: "i2", role: "researcher" });
      workflow.trackerInstance = projectTracker();
      workflow.patchState({ subject: { kind: "project", project_id: "proj-1" } });
      const { ready_issues } = trackerTools(workflow);
      lines = toolText(await ready_issues.execute({}, call)).split("\n");
    });

    it("skips the issue the researcher owns", () =>
      listed(() => {
        expect(lines.filter((line) => line.startsWith("- ENG-2"))).toEqual([]);
      }));
  });
});
