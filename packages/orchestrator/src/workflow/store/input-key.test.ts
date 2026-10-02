import { describe, expect, it } from "bun:test";
import { seedIssuesTask, seedTask } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario } from "../../../test/scenario";
import { jobInputFor, jobInputKey } from "./input-key";

const ISSUE = { id: "issue-1", key: "ENG-1", title: "Fix login", team_id: null, started: false };

const PAGE = { ref: { kind: "page" as const, page_id: "page-7" }, url: "https://docs.test/page-7" };

const PULL = {
  ref: { kind: "pull" as const, repo: "acme/app", number: 12 },
  url: "https://github.com/acme/app/pull/12",
};

const ISSUES = { ref: { kind: "issues" as const }, url: "https://tracker.test/project/p1" };

const NONE = { issue: null, target: null };

const REQUEST = "Fix the login redirect.";

describe("jobInputKey", () => {
  it("keys an issue by its id", () => {
    expect(jobInputKey({ kind: "issue", issue: ISSUE })).toBe("issue-1");
  });

  it("keys a page target by the host's id for it", () => {
    expect(jobInputKey({ kind: "target", target: PAGE })).toBe("page:page-7");
  });

  it("keys a pull target by its repository and number", () => {
    expect(jobInputKey({ kind: "target", target: PULL })).toBe("pull:acme/app#12");
  });

  it("keys an issue set target by its link", () => {
    expect(jobInputKey({ kind: "target", target: ISSUES })).toBe(
      "issues:https://tracker.test/project/p1",
    );
  });

  it("keys an artifact by the job that produced it", () => {
    expect(jobInputKey({ kind: "artifact", jobId: "wf_x-1" })).toBe("artifact:wf_x-1");
  });

  it("keys a request by the sha256 hex of its text", () => {
    expect(jobInputKey({ kind: "request", text: "abc" })).toBe(
      "request:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("gives the same text the same key", () => {
    const first = jobInputKey({ kind: "request", text: REQUEST });
    const second = jobInputKey({ kind: "request", text: REQUEST });
    expect(first).toBe(second);
  });

  it("gives another text another key", () => {
    const first = jobInputKey({ kind: "request", text: REQUEST });
    const second = jobInputKey({ kind: "request", text: "Add a logout link." });
    expect(first).not.toBe(second);
  });
});

describe("jobInputFor", () => {
  describe("a workflow with no job", () => {
    const fresh = scenario(freshRuntime, () => {});

    it("works from the request", () =>
      fresh((workflow) => {
        expect(jobInputFor(workflow, NONE, REQUEST)).toEqual({ kind: "request", text: REQUEST });
      }));

    it("works from the issue it names", () =>
      fresh((workflow) => {
        expect(jobInputFor(workflow, { issue: ISSUE, target: null }, REQUEST)).toEqual({
          kind: "issue",
          issue: ISSUE,
        });
      }));

    it("works from the artifact it names", () =>
      fresh((workflow) => {
        expect(jobInputFor(workflow, { issue: null, target: PAGE }, REQUEST)).toEqual({
          kind: "target",
          target: PAGE,
        });
      }));
  });

  describe("a completed job whose artifact is ready", () => {
    const completed = scenario(freshRuntime, (workflow) => {
      seedIssuesTask(workflow, { task_id: "wf_x.1", status: "done" }, { status: "ready" });
    });

    it("builds on that artifact", () =>
      completed((workflow) => {
        expect(jobInputFor(workflow, NONE, REQUEST)).toEqual({ kind: "artifact", jobId: "wf_x-1" });
      }));

    it("still works from a named issue", () =>
      completed((workflow) => {
        expect(jobInputFor(workflow, { issue: ISSUE, target: null }, REQUEST)).toEqual({
          kind: "issue",
          issue: ISSUE,
        });
      }));

    it("still works from a named artifact", () =>
      completed((workflow) => {
        expect(jobInputFor(workflow, { issue: null, target: PAGE }, REQUEST)).toEqual({
          kind: "target",
          target: PAGE,
        });
      }));

    describe("and a later completed job whose artifact is a draft", () => {
      const drafted = scenario(completed, (workflow) => {
        seedIssuesTask(workflow, { task_id: "wf_x.2", status: "done" });
      });

      it("builds on the ready artifact", () =>
        drafted((workflow) => {
          expect(jobInputFor(workflow, NONE, REQUEST)).toEqual({
            kind: "artifact",
            jobId: "wf_x-1",
          });
        }));
    });
  });

  describe("a job whose artifact is ready but whose author still works", () => {
    const working = scenario(freshRuntime, (workflow) => {
      seedIssuesTask(workflow, { task_id: "wf_x.1", status: "in_review" }, { status: "ready" });
    });

    it("works from the request", () =>
      working((workflow) => {
        expect(jobInputFor(workflow, NONE, REQUEST)).toEqual({ kind: "request", text: REQUEST });
      }));
  });

  describe("a completed job and a later job whose researcher still works", () => {
    const researching = scenario(freshRuntime, (workflow) => {
      seedIssuesTask(workflow, { task_id: "wf_x.1", status: "done" }, { status: "ready" });
      seedTask(workflow, { task_id: "wf_x.2", role: "researcher" });
    });

    it("builds on the artifact of the completed job", () =>
      researching((workflow) => {
        expect(jobInputFor(workflow, NONE, REQUEST)).toEqual({ kind: "artifact", jobId: "wf_x-1" });
      }));
  });
});
