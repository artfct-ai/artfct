import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";
import { jobSessionOf, runningAuthorInSession, type TrackerSession } from "./job-session";

const STARTING: TrackerSession = { source: "tracker", session_id: "s-start", issue_id: "ENG-1" };
const ON_ISSUE: TrackerSession = { source: "tracker", session_id: "s-issue", issue_id: "iss-2" };
const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };

function fromSession(workflow: FakeRuntime): void {
  workflow.patchState({ origin: STARTING, reply_targets: [STARTING, ON_ISSUE] });
}

describe("jobSessionOf", () => {
  describe("a job on an issue with its own session", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-2" });
    });

    it("is the session on the issue", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toEqual(ON_ISSUE);
      }));
  });

  describe("a job without an issue", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow);
    });

    it("is the starting session", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toEqual(STARTING);
      }));
  });

  describe("a job of a workflow that started in chat", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      workflow.patchState({ origin: THREAD, reply_targets: [THREAD] });
      seedTask(workflow);
    });

    it("has none", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toBeNull();
      }));
  });
});

describe("runningAuthorInSession", () => {
  describe("a session whose author works", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-2" });
    });

    it("is that author", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, ON_ISSUE)?.task_id).toBe("wf_x.1");
      }));

    it("is none in another session", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, STARTING)).toBeNull();
      }));
  });

  describe("a session whose author is in review", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-2", status: "in_review" });
    });

    it("is none", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, ON_ISSUE)).toBeNull();
      }));
  });

  describe("a starting session shared by two jobs whose authors work", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow);
      seedTask(workflow, { task_id: "wf_x.2" });
    });

    it("is none, since the message names neither", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, STARTING)).toBeNull();
      }));
  });

  describe("a starting session where one of two jobs still works", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { status: "done" });
      seedTask(workflow, { task_id: "wf_x.2" });
    });

    it("is the author that works", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, STARTING)?.task_id).toBe("wf_x.2");
      }));
  });
});
