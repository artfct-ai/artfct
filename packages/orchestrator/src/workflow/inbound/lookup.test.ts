import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { seedPullRequestTask, seedTask } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { jobForEvent, jobsForEvent } from "./lookup";

const reply: InboundEvent = {
  id: "evt-doc-reply",
  kind: "prompt",
  actor: null,
  bindings: [{ source: "documents_page", external_id: "content2" }],
  links: [],
  text: "looks good",
};

describe("jobForEvent", () => {
  describe("two jobs, the second holding the document artifact", () => {
    const twoTasks = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1" });
      seedTask(workflow, { task_id: "wf_x.2" });
      workflow.store.upsertArtifact({
        job_id: "wf_x-2",
        kind: "page",
        external_url: "https://linear.app/acme/document/design-a1b2c3d4e5f6",
        ref: { kind: "page", page_id: "content2" },
      });
    });

    it("routes a document event to the job whose artifact it is", () =>
      twoTasks((workflow) => {
        expect(jobForEvent(workflow, reply)?.job_id).toBe("wf_x-2");
      }));

    it("answers null for a binding no artifact carries", () =>
      twoTasks((workflow) => {
        const unknown: InboundEvent = {
          ...reply,
          bindings: [{ source: "documents_page", external_id: "x" }],
        };
        expect(jobForEvent(workflow, unknown)).toBeNull();
      }));
  });

  describe("one job holding a pull request", () => {
    const oneTask = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow);
    });

    it("routes a document reply to it, since it is the only active job", () =>
      oneTask((workflow) => {
        expect(jobForEvent(workflow, { ...reply, bindings: [] })?.job_id).toBe("wf_x-1");
      }));

    it("answers null for a pull request nothing here matches", () =>
      oneTask((workflow) => {
        expect(jobForEvent(workflow, strangerPull)).toBeNull();
      }));

    it("routes a conversation comment on its pull request to it", () =>
      oneTask((workflow) => {
        expect(jobForEvent(workflow, conversationComment)?.job_id).toBe("wf_x-1");
      }));

    it("still routes one once its author has ended", () =>
      oneTask((workflow) => {
        workflow.store.updateTask("wf_x.1", { status: "done" });
        expect(jobForEvent(workflow, conversationComment)?.job_id).toBe("wf_x-1");
      }));
  });
});

const conversationComment: InboundEvent = {
  id: "evt-comment-1",
  kind: "feedback",
  actor: null,
  bindings: [{ source: "code_pull", repo: "acme/app", number: 1 }],
  links: [],
  text: "so are you saying this gets ignored now",
  pull: { action: "comment", repo: "acme/app", number: 1, reviewer: "octocat", comment_id: 55 },
};

const strangerPull: InboundEvent = {
  id: "evt-pr-9",
  kind: "pr_event",
  actor: null,
  bindings: [],
  links: [],
  text: "",
  pull: { repo: "acme/app", number: 9, action: "closed", branch: "someone/else" },
};

describe("jobsForEvent", () => {
  const oneTask = scenario(freshRuntime, (workflow) => {
    seedPullRequestTask(workflow);
  });

  it("names no job for a pull request nothing here matches", () =>
    oneTask((workflow) => {
      expect(jobsForEvent(workflow, strangerPull)).toEqual([]);
    }));

  it("fans a base branch push out over the open artifacts", () =>
    oneTask((workflow) => {
      const moved: InboundEvent = {
        ...strangerPull,
        id: "evt-push",
        pull: { repo: "acme/app", action: "base_moved", base: "main" },
      };
      expect(jobsForEvent(workflow, moved).map((job) => job.job_id)).toEqual(["wf_x-1"]);
    }));
});
