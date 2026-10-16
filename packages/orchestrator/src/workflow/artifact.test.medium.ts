import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import type { TrackerIssue } from "@artfct-ai/adapters/tracker/types";
import type { Subject } from "./store/state";
import { describe, expect, it } from "vitest";
import { findBinding } from "../db/bindings";
import { createDb } from "../db/client";
import { createWorkflow } from "../db/workflows";
import { freshDurableRuntime } from "../../test/durable-runtime";
import { patchStageReviewers, seedTask, type FakeRuntime } from "../../test/fake-runtime";
import { scenario, type Scenario } from "../../test/scenario";
import {
  detectArtifact,
  detectArtifactAfterTurn,
  stageHasRefiners,
  recordArtifact,
} from "./artifact";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const PR_URL = "https://github.com/acme/app/pull/1";
const TARGET = { url: PR_URL, ref: { kind: "pull" as const, repo: "acme/app", number: 1 } };

function seedAuthor(workflow: FakeRuntime, patch = {}, sandbox = {}) {
  workflow.patchState({ repo: { full: "acme/app" } });
  return seedTask(workflow, { stage: "implement", branch: "artfct/wf_x-1-fix", ...patch }, sandbox);
}

function readyEvents(workflow: FakeRuntime) {
  return workflow.posted.filter((event) => event.type === "artifact_ready");
}

describe("recordArtifact", () => {
  const recorded: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
    await createWorkflow(createDb(workflow.env.DB), workflow.state.workflow_id);
    await recordArtifact(workflow, seedAuthor(workflow), TARGET);
  });

  it("stores the artifact under its kind", () =>
    recorded((workflow) => {
      expect(workflow.store.artifact(JOB)).toMatchObject({
        kind: "pull",
        external_url: PR_URL,
        status: "drafted",
      });
    }));

  it("puts the idle author in review", () =>
    recorded((workflow) => {
      expect(workflow.store.requireTask(TASK).status).toBe("in_review");
    }));

  it("binds the artifact, so its webhooks route back to this workflow", () =>
    recorded(async (workflow) => {
      const db = createDb(workflow.env.DB);
      const binding = { source: "code_pull", repo: "acme/app", number: 1 } as const;
      expect((await findBinding(db, binding))?.workflow_id).toBe("wf_x");
    }));

  it("says in the log what was recorded", () =>
    recorded((workflow) => {
      expect(workflow.lines).toContain(`artifact pull ${PR_URL}`);
    }));

  it("holds the announcement while a review is due", () =>
    recorded((workflow) => {
      expect(workflow.lines).toContain("holding the announcement until the review settles");
      expect(readyEvents(workflow)).toEqual([]);
    }));

  describe("an author that has not run yet", () => {
    const early = scenario(freshDurableRuntime, async (workflow) => {
      await recordArtifact(workflow, seedAuthor(workflow, { status: "queued" }), TARGET);
    });

    it("puts the author in review, so its sandbox does not prompt it", () =>
      early((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("in_review");
      }));
  });

  describe("an author whose turn still runs", () => {
    const midTurn = scenario(freshDurableRuntime, async (workflow) => {
      const author = seedAuthor(workflow, { status: "working" }, { prompt_in_flight: 1 });
      await recordArtifact(workflow, author, TARGET);
    });

    it("stores the artifact", () =>
      midTurn((workflow) => {
        expect(workflow.store.artifact(JOB)?.external_url).toBe(PR_URL);
      }));

    it("keeps the author working until its turn ends", () =>
      midTurn((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("working");
      }));
  });

  describe("a stage that declares no reviewers", () => {
    const unreviewed: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      const task = seedAuthor(workflow);
      patchStageReviewers(workflow, []);
      await recordArtifact(workflow, task, TARGET);
    });

    it("gives the artifact to the humans at once", () =>
      unreviewed((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("closes healthy, on the one line the kind wrote", () =>
      unreviewed((workflow) => {
        expect(readyEvents(workflow)[0]).toMatchObject({
          text: `The pull request is ready for you: ${PR_URL}`,
        });
      }));
  });
});

describe("detectArtifact", () => {
  const printed: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
    await detectArtifact(workflow, seedAuthor(workflow), `Opened ${PR_URL}`);
  });

  it("records the artifact the author printed", () =>
    printed((workflow) => {
      expect(workflow.store.artifact(JOB)?.external_url).toBe(PR_URL);
    }));

  describe("an author whose turn ended without a link", () => {
    const byBranch: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      const pull = pullRequest({
        number: 1,
        html_url: PR_URL,
        head: { ref: "artfct/wf_x-1-fix", sha: "abc123" },
      });
      workflow.codeHostInstance = new FakeCodeHost({ pulls: [pull] });
      await detectArtifactAfterTurn(workflow, seedAuthor(workflow), "Pushed it.");
    });

    it("asks the host what is open on the task branch", () =>
      byBranch((workflow) => {
        expect(workflow.store.artifact(JOB)?.external_url).toBe(PR_URL);
      }));
  });

  describe("an author whose output names no artifact", () => {
    const none: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      const found = await detectArtifact(workflow, seedAuthor(workflow), "Still working.");
      expect(found).toBe(false);
    });

    it("records nothing", () =>
      none((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));
  });

  describe("a task that already has one", () => {
    const kept: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      const task = seedAuthor(workflow);
      await recordArtifact(workflow, task, TARGET);
      const found = await detectArtifact(
        workflow,
        task,
        "Opened https://github.com/acme/app/pull/9",
      );
      expect(found).toBe(true);
    });

    it("keeps the first one", () =>
      kept((workflow) => {
        expect(workflow.store.artifact(JOB)?.external_url).toBe(PR_URL);
      }));
  });

  describe("a reviewer run", () => {
    const reviewer: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      const task = seedAuthor(workflow, { role: "reviewer" });
      const found = await detectArtifact(workflow, task, `Opened ${PR_URL}`);
      expect(found).toBe(false);
    });

    it("records nothing, since only an author produces an artifact", () =>
      reviewer((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));
  });

  describe("a host that cannot be asked", () => {
    const failed: Scenario<FakeRuntime> = scenario(freshDurableRuntime, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ failing: true });
      await detectArtifactAfterTurn(workflow, seedAuthor(workflow), "Pushed it.");
    });

    it("says so and records nothing", () =>
      failed((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
        expect(workflow.lines.some((line) => line.includes("lookup failed"))).toBe(true);
      }));
  });
});

const SUBJECT_ISSUE: TrackerIssue = {
  id: "i100",
  identifier: "ENG-100",
  title: "Fix login",
  url: "https://linear.app/acme/issue/ENG-100/fix-login",
  state: { type: "unstarted", name: "Todo" },
  team_id: null,
  parent_id: null,
  project_id: null,
  labels: [],
  blockers: [],
};

const STRAY_URL = "https://linear.app/acme/issue/ENG-400/other";

const PROJECT = {
  id: "proj-1",
  name: "Login",
  url: "https://linear.app/acme/project/login-a1b2c3",
};

function breakdownEnds(subject: Subject | null, turnText: string): Scenario<FakeRuntime> {
  return scenario(freshDurableRuntime, async (workflow) => {
    workflow.trackerInstance = new FakeTracker({
      issues: [
        SUBJECT_ISSUE,
        { ...SUBJECT_ISSUE, id: "i400", identifier: "ENG-400", url: STRAY_URL },
      ],
      projects: { a1b2c3: PROJECT, [PROJECT.id]: PROJECT },
    });
    workflow.patchState({ subject });
    const task = seedTask(workflow, { stage: "breakdown" });
    await detectArtifact(workflow, task, `The issues are in ${PROJECT.url}.`);
    await detectArtifactAfterTurn(workflow, task, turnText);
  });
}

describe("the output of a breakdown author", () => {
  describe("a project, in a workflow without a subject", () => {
    const ended = breakdownEnds(null, `The issues are in ${PROJECT.url}.`);

    it("is recorded once the turn ends", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(JOB)?.ref).toEqual({
          kind: "project",
          project_id: "proj-1",
        });
      }));

    it("becomes the subject", () =>
      ended((workflow) => {
        expect(workflow.state.subject).toEqual({ kind: "project", project_id: "proj-1" });
      }));
  });

  describe("an issue other than the subject issue", () => {
    const ended = breakdownEnds(
      { kind: "issue", issue_id: "i100" },
      `I opened ${SUBJECT_ISSUE.url}, then moved the work to ${STRAY_URL}.`,
    );

    it("is not recorded", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(JOB)).toBeNull();
      }));

    it("tells the author to put the work in the subject", () =>
      ended((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([
          `Your output names another issue than the subject of this workflow, ENG-100 (${SUBJECT_ISSUE.url}). A workflow works only its own subject. Put the work in ENG-100 (${SUBJECT_ISSUE.url}) and end your turn with its link.`,
        ]);
      }));

    it("keeps the subject", () =>
      ended((workflow) => {
        expect(workflow.state.subject).toEqual({ kind: "issue", issue_id: "i100" });
      }));
  });

  describe("the subject issue", () => {
    const ended = breakdownEnds({ kind: "issue", issue_id: "i100" }, `Done: ${SUBJECT_ISSUE.url}`);

    it("is recorded", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(JOB)?.ref).toEqual({
          kind: "issue",
          issue_id: "i100",
          issue_key: "ENG-100",
        });
      }));
  });
});

describe("stageHasRefiners", () => {
  const stages: Scenario<FakeRuntime> = scenario(freshDurableRuntime, () => {});

  it("is true for a stage that declares reviewers", () =>
    stages((workflow) => {
      expect(stageHasRefiners(workflow.stageForTask(seedAuthor(workflow)))).toBe(true);
    }));

  it("is false when the stage declares none", () =>
    stages((workflow) => {
      const task = seedAuthor(workflow);
      patchStageReviewers(workflow, []);
      expect(stageHasRefiners(workflow.stageForTask(task))).toBe(false);
    }));
});
