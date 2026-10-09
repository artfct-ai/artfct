import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";
import {
  authorInSession,
  jobSessionOf,
  runningAuthorInSession,
  type TrackerSession,
} from "./job-session";

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

  describe("a job on the issue the workflow started from", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "ENG-1" });
    });

    it("is the starting session", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toEqual(STARTING);
      }));
  });

  describe("a job without an input issue", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow);
    });

    it("has none, not even the starting session", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toBeNull();
      }));
  });

  describe("a job on an issue without a session", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-3" });
    });

    it("has none", () =>
      seeded((workflow) => {
        expect(jobSessionOf(workflow, workflow.store.jobs()[0]!)).toBeNull();
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

  describe("the starting session of jobs without an input issue", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow);
    });

    it("is none", () =>
      seeded((workflow) => {
        expect(runningAuthorInSession(workflow, STARTING)).toBeNull();
      }));
  });
});

describe("authorInSession", () => {
  describe("an issue whose first job finished and whose second job works", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-2", status: "done" });
      seedTask(workflow, { issue_id: "iss-2", task_id: "wf_x.2" });
    });

    it("is the author that works", () =>
      seeded((workflow) => {
        expect(authorInSession(workflow, ON_ISSUE)?.task_id).toBe("wf_x.2");
      }));
  });

  describe("an issue whose only job finished", () => {
    const seeded = scenario(freshRuntime, (workflow) => {
      fromSession(workflow);
      seedTask(workflow, { issue_id: "iss-2", status: "done" });
    });

    it("is that finished author", () =>
      seeded((workflow) => {
        expect(authorInSession(workflow, ON_ISSUE)?.task_id).toBe("wf_x.1");
      }));
  });
});
