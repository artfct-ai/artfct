import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import { describe, expect, it } from "vitest";
import { plannedWorkflow } from "../../../../test/fresh-workflow";
import type { Scenario } from "../../../../test/scenario";
import { toolText } from "../../../../test/tool-result";
import type { Workflow } from "../../../workflow";
import { startTools } from "./start";

const call = { toolCallId: "call-1", messages: [], context: {} };

function trackerIssue(patch: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: "i9",
    identifier: "ENG-9",
    title: "Nine",
    url: "https://tracker.example/acme/issue/ENG-9",
    state: { type: "unstarted", name: "Todo" },
    team_id: "team-1",
    labels: [],
    blockers: [],
    ...patch,
  };
}

type IssueStart = { workflow: Workflow; tracker: FakeTracker; result: string };

function startedOnIssue(issue: TrackerIssue | null, appUserId?: string): Scenario<IssueStart> {
  return (run) => {
    let tracker: FakeTracker;
    return plannedWorkflow(2, () => {
      tracker = new FakeTracker({ issue, appUserId });
      return { tracker };
    })(async (workflow) => {
      const { start_job } = startTools(workflow);
      const result = toolText(
        await start_job.execute({ stage: "implement", brief: "x", issue: "ENG-9" }, call),
      );
      await run({ workflow, tracker, result });
    });
  };
}

describe("start_job with a tracker", () => {
  describe("an issue the tracker does not have", () => {
    const refused = startedOnIssue(null);

    it("says the tracker has no such issue", () =>
      refused(({ result }) => {
        expect(result).toBe("The tracker has no issue ENG-9.");
      }));

    it("records no job", () =>
      refused(({ workflow }) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("an issue that is finished", () => {
    const refused = startedOnIssue(trackerIssue({ state: { type: "completed", name: "Done" } }));

    it("names the state it is in", () =>
      refused(({ result }) => {
        expect(result).toBe("ENG-9 is Done.");
      }));

    it("records no job", () =>
      refused(({ workflow }) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("an issue with an unfinished blocker", () => {
    const refused = startedOnIssue(
      trackerIssue({ blockers: [{ id: "i8", identifier: "ENG-8", state: { type: "started" } }] }),
    );

    it("names the issue that blocks it", () =>
      refused(({ result }) => {
        expect(result).toBe("ENG-9 is blocked by ENG-8.");
      }));

    it("records no job", () =>
      refused(({ workflow }) => {
        expect(workflow.store.jobs()).toHaveLength(0);
      }));
  });

  describe("an issue that is ready, under an API key", () => {
    const started = startedOnIssue(trackerIssue());

    it("names the job, the stage, the issue, and the branch", () =>
      started(({ result }) => {
        expect(result).toMatch(/^Started job \S+-1 for stage implement for ENG-9 on branch /);
      }));

    it("records the issue on the job", () =>
      started(({ workflow }) => {
        expect(workflow.store.jobs().map((job) => [job.issue_id, job.issue_key])).toEqual([
          ["i9", "ENG-9"],
        ]);
      }));

    it("looks the issue up, then claims it with one move and no delegate", () =>
      started(({ tracker }) => {
        expect(tracker.calls).toEqual([
          { method: "issue", args: ["ENG-9"] },
          { method: "teamStates", args: ["team-1"] },
          { method: "updateIssue", args: ["i9", { stateId: "st-progress" }] },
        ]);
      }));
  });

  describe("an issue that is ready, under the installed app", () => {
    const started = startedOnIssue(trackerIssue(), "app1");

    it("moves and delegates in one update", () =>
      started(({ tracker }) => {
        expect(tracker.calls.at(-1)).toEqual({
          method: "updateIssue",
          args: ["i9", { stateId: "st-progress", delegateId: "app1" }],
        });
      }));
  });

  describe("an issue that is already started, under the installed app", () => {
    const started = startedOnIssue(
      trackerIssue({ state: { type: "started", name: "In Progress" } }),
      "app1",
    );

    it("only delegates it", () =>
      started(({ tracker }) => {
        expect(tracker.calls).toEqual([
          { method: "issue", args: ["ENG-9"] },
          { method: "updateIssue", args: ["i9", { delegateId: "app1" }] },
        ]);
      }));
  });
});
