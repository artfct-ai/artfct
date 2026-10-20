import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../test/fresh-runtime";
import { seedTask, type FakeRuntime, patchStagePlan } from "../../test/fake-runtime";
import type { Subject } from "./store/state";
import {
  issueInSubject,
  isSingleIssueWorkflow,
  jobCompletesSingleIssueWorkflow,
  originSubject,
  setWorkflowSubject,
} from "./subject";

const ISSUE_SUBJECT: Subject = { kind: "issue", issue_id: "i1" };
const PROJECT_SUBJECT: Subject = { kind: "project", project_id: "proj-1" };
const THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;
const SESSION = { source: "tracker", session_id: "s1", issue_id: "i1" } as const;

function issue(id: string, place: { parent_id?: string; project_id?: string }): TrackerIssue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    url: `https://tracker.example/${id}`,
    state: { type: "unstarted", name: "Todo" },
    team_id: null,
    parent_id: place.parent_id ?? null,
    project_id: place.project_id ?? null,
    labels: [],
    blockers: [],
  };
}

function chatThreadLinks(workflow: FakeRuntime): unknown[] {
  return workflow.store
    .outbox()
    .filter((row) => row.kind === "attach_chat_thread")
    .map((row) => row.target);
}

describe("originSubject", () => {
  it("is the issue of a tracker session", () => {
    expect(originSubject(SESSION)).toEqual(ISSUE_SUBJECT);
  });

  it("is null for a chat thread", () => {
    expect(originSubject(THREAD)).toBeNull();
  });
});

describe("issueInSubject", () => {
  it("holds the subject issue and its direct sub-issues", () => {
    expect(
      [issue("i1", {}), issue("i2", { parent_id: "i1" }), issue("i3", { parent_id: "i2" })].map(
        (candidate) => issueInSubject(ISSUE_SUBJECT, candidate),
      ),
    ).toEqual([true, true, false]);
  });

  it("holds the issues of the subject project", () => {
    expect(
      [issue("i1", { project_id: "proj-1" }), issue("i2", { project_id: "proj-2" })].map(
        (candidate) => issueInSubject(PROJECT_SUBJECT, candidate),
      ),
    ).toEqual([true, false]);
  });
});

describe("setWorkflowSubject", () => {
  it("links the chat thread of a chat workflow to an issue subject", () =>
    freshRuntime(async (workflow) => {
      workflow.store.updateWorkflow({ origin: THREAD });
      await setWorkflowSubject(workflow, ISSUE_SUBJECT);
      expect([workflow.store.subject(), chatThreadLinks(workflow)]).toEqual([
        ISSUE_SUBJECT,
        [{ issue_id: "i1" }],
      ]);
    }));

  it("links nothing for a project subject", () =>
    freshRuntime(async (workflow) => {
      workflow.store.updateWorkflow({ origin: THREAD });
      await setWorkflowSubject(workflow, PROJECT_SUBJECT);
      expect(chatThreadLinks(workflow)).toEqual([]);
    }));

  it("links nothing in a workflow from a tracker session", () =>
    freshRuntime(async (workflow) => {
      workflow.store.updateWorkflow({ origin: SESSION });
      await setWorkflowSubject(workflow, ISSUE_SUBJECT);
      expect(chatThreadLinks(workflow)).toEqual([]);
    }));
});

describe("a single-issue workflow", () => {
  it("has an issue subject and plans no stage that produces issues", () =>
    freshRuntime((workflow) => {
      patchStagePlan(workflow, { stages: ["design", "implement"] });
      workflow.store.writeSubject(ISSUE_SUBJECT);
      expect(isSingleIssueWorkflow(workflow)).toBe(true);
    }));

  it("is not one when a planned stage produces issues", () =>
    freshRuntime((workflow) => {
      patchStagePlan(workflow, { stages: ["design", "breakdown"] });
      workflow.store.writeSubject(ISSUE_SUBJECT);
      expect(isSingleIssueWorkflow(workflow)).toBe(false);
    }));

  it("is not one with a project subject", () =>
    freshRuntime((workflow) => {
      patchStagePlan(workflow, { stages: ["implement"] });
      workflow.store.writeSubject(PROJECT_SUBJECT);
      expect(isSingleIssueWorkflow(workflow)).toBe(false);
    }));

  it("is completed by the job on the subject issue at the last planned stage", () =>
    freshRuntime((workflow) => {
      patchStagePlan(workflow, { stages: ["design", "implement"] });
      workflow.store.writeSubject(ISSUE_SUBJECT);
      seedTask(workflow, { task_id: "wf_x.1", stage: "implement", issue_id: "i1" });
      seedTask(workflow, { task_id: "wf_x.2", stage: "design", issue_id: "i1" });
      seedTask(workflow, { task_id: "wf_x.3", stage: "implement", issue_id: "i2" });
      expect(
        ["wf_x-1", "wf_x-2", "wf_x-3"].map((jobId) =>
          jobCompletesSingleIssueWorkflow(workflow, workflow.store.requireJob(jobId)),
        ),
      ).toEqual([true, false, false]);
    }));
});
