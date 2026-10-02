import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import type { PullRequest, PullRequestReview } from "@artfct-ai/adapters/code/types";
import { describe, expect, it } from "bun:test";
import {
  JUDGE_CONCLUSION,
  JUDGE_ENTRY,
  patchStageReviewers,
  stubRulingModel,
  seedIssuesTask,
  seedPullRequestTask,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import type { ReviewerEntry } from "../../config/refiner";
import {
  taskQuiet,
  heldForReview,
  onReviewerFailed,
  onReviewerFinished,
  refinerInFlight,
  settleRefinersForAuthor,
  startRefiner,
} from "./loop";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const PR_URL = "https://github.com/acme/app/pull/1";
const ISSUES_URL = "https://linear.app/acme/issue/ENG-42";

function storedReview(summary: string, body: string, blocking: boolean) {
  return {
    kind: "review" as const,
    revision: "abc123",
    blocking,
    summary,
    findings: [{ location: "src/login.ts", body }],
  };
}

function announcedText(workflow: FakeRuntime): string {
  const announced = workflow.posted.find((event) => event.type === "artifact_ready");
  return announced?.type === "artifact_ready" ? announced.text : "";
}

function submittedReview(patch: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    id: 501,
    user: { login: "acme-review[bot]" },
    state: "COMMENTED",
    body: "Looks fine.",
    submitted_at: new Date(Date.now() + 1000).toISOString(),
    commit_id: "abc123",
    ...patch,
  };
}

function reviewHost(review: PullRequestReview, comments: Parameters<typeof commentsOf>[0] = []) {
  return new FakeCodeHost({
    pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } })],
    reviews: { 1: [review] },
    reviewComments: { [review.id]: commentsOf(comments) },
  });
}

function commentsOf(rows: Array<{ path: string; line: number | null; body: string }>) {
  return rows.map((row, index) => ({
    id: 900 + index,
    path: row.path,
    line: row.line,
    original_line: row.line,
    body: row.body,
  }));
}

/** A host that queues a prompt for the author while its head revision is being read. */
class PromptArrivesDuringRevision extends FakeCodeHost {
  constructor(
    private readonly workflow: FakeRuntime,
    review: PullRequestReview,
  ) {
    super({
      pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } })],
      reviews: { 1: [review] },
      reviewComments: { [review.id]: commentsOf([]) },
    });
  }

  override async getPull(repo: string, number: number): Promise<PullRequest> {
    this.workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
    return super.getPull(repo, number);
  }
}

/** A host that holds the review but fails every read of the pull request itself. */
class PullUnreadable extends FakeCodeHost {
  override async getPull(): Promise<PullRequest> {
    throw new Error("getPull: host down");
  }
}

const started: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
  await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
});

function reviewerOf(workflow: FakeRuntime) {
  const reviewerId = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
  return workflow.store.requireTask(reviewerId);
}

describe("settle", () => {
  describe("an idle author whose artifact nobody has reviewed", () => {
    it("starts one reviewer", () =>
      started((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));

    it("starts the first entry of the list", () =>
      started((workflow) => {
        expect(reviewerOf(workflow)).toMatchObject({
          role: "reviewer",
          refiner_index: 0,
          job_id: JOB,
          status: "queued",
        });
      }));

    it("tells the channel nothing, since the board carries the run", () =>
      started((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("keeps the artifact drafted", () =>
      started((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("wakes the orchestrator agent for nothing", () =>
      started((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });

  describe("an author with a prompt in flight", () => {
    it("starts no reviewer, since the artifact may still change", () =>
      freshRuntime(async (workflow) => {
        const author = seedPullRequestTask(workflow);
        workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
        await settleRefinersForAuthor(workflow, author);
        expect(workflow.store.activeRefinerRuns()).toHaveLength(0);
      }));
  });

  describe("an idle author a reviewer already read", () => {
    const routed = scenario(started, async (workflow) => {
      const reviewer = reviewerOf(workflow);
      workflow.store.updateTask(reviewer.task_id, { status: "done" });
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
    });

    it("starts no second reviewer on its own", () =>
      routed((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(0);
      }));

    it("asks the agent to route the artifact", () =>
      routed((workflow) => {
        expect(workflow.notes.at(-1)?.text).toContain(
          `The agent review of ${PR_URL} in job ${JOB} is with you.`,
        );
      }));

    it("names both tools the agent may call", () =>
      routed((workflow) => {
        const text = workflow.notes.at(-1)?.text ?? "";
        expect(text).toContain("request_review");
        expect(text).toContain("finish_review");
      }));

    it("names the entries of the open segment", () =>
      routed((workflow) => {
        expect(workflow.notes.at(-1)?.text).toContain(
          "The open segment is the entries Code review.",
        );
      }));

    it("tells the agent to end the turn silent unless a person must decide", () =>
      routed((workflow) => {
        expect(workflow.notes.at(-1)?.text).toContain(
          "end the turn silent unless a person must decide something",
        );
      }));
  });

  describe("an idle author who answered a review that reached the review limit", () => {
    const limited = scenario(started, async (workflow) => {
      workflow.patchConfig({
        orchestrator: { ...workflow.config().orchestrator, max_review_runs: 1 },
      });
      workflow.store.updateTask(reviewerOf(workflow).task_id, {
        status: "done",
        result: storedReview("Needs work.", "This drops the error.", true),
      });
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
    });

    it("starts no second reviewer run", () =>
      limited((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
      }));

    it("gives the artifact to the humans", () =>
      limited((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says that no reviewer read the last revision", () =>
      limited((workflow) => {
        expect(announcedText(workflow)).toBe(
          `The pull request is ready for you: ${PR_URL}\nThe author answered the latest review findings. The agent review reached its limit of 1 run, so that revision did not get a review.`,
        );
      }));

    it("does not ask the agent to route the artifact", () =>
      limited((workflow) => {
        expect(workflow.notes.filter((note) => note.text.includes("is with you"))).toEqual([]);
      }));
  });

  describe("an author task that is over while its artifact is held", () => {
    const over = scenario(freshRuntime, async (workflow) => {
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow, { status: "done" }));
    });

    it("gives the artifact to the humans instead of holding it", () =>
      over((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says why the review stopped", () =>
      over((workflow) => {
        expect(announcedText(workflow)).toBe(`The agent review stopped: wf_x.1 is done. ${PR_URL}`);
      }));
  });

  describe("a stage that declares no reviewers", () => {
    it("holds nothing back", () =>
      freshRuntime(async (workflow) => {
        patchStageReviewers(workflow, []);
        const task = seedPullRequestTask(workflow);
        expect(heldForReview(workflow, workflow.store.artifact(JOB)!)).toBe(false);
        await settleRefinersForAuthor(workflow, task);
        expect(workflow.store.activeRefinerRuns()).toHaveLength(0);
      }));
  });
});

describe("heldForReview", () => {
  it("is false once the artifact is ready", () =>
    freshRuntime((workflow) => {
      seedPullRequestTask(workflow, {}, { status: "ready" });
      expect(heldForReview(workflow, workflow.store.artifact(JOB)!)).toBe(false);
    }));

  it("is true while the artifact is a draft of a reviewed kind", () =>
    freshRuntime((workflow) => {
      seedPullRequestTask(workflow);
      expect(heldForReview(workflow, workflow.store.artifact(JOB)!)).toBe(true);
    }));
});

describe("settleRefinersForAuthor", () => {
  it("does nothing for a task with no artifact", () =>
    freshRuntime(async (workflow) => {
      await settleRefinersForAuthor(workflow, seedTask(workflow));
      expect(workflow.store.refinerRunsOf("wf_x.1")).toEqual([]);
    }));

  it("does nothing for a stage that declares no reviewers", () =>
    freshRuntime(async (workflow) => {
      patchStageReviewers(workflow, []);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
    }));

  it("does nothing while a refiner runs", () =>
    started(async (workflow) => {
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
    }));

  it("does nothing while the author answers findings", () =>
    freshRuntime(async (workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.enqueuePrompt(TASK, "fix it");
      await settleRefinersForAuthor(workflow, task);
      expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
    }));

  it("runs the list from the top while no entry is open", () =>
    freshRuntime(async (workflow) => {
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      expect(reviewerOf(workflow).refiner_index).toBe(0);
    }));

  it("hands a held artifact with an open entry to the agent", () =>
    started(async (workflow) => {
      workflow.store.updateTask(reviewerOf(workflow).task_id, { status: "done" });
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      expect(workflow.notes.at(-1)?.text).toContain(
        `The agent review of ${PR_URL} in job ${JOB} is with you.`,
      );
    }));

  it("does nothing once the artifact is with the humans", () =>
    freshRuntime(async (workflow) => {
      const task = seedPullRequestTask(workflow, {}, { status: "ready" });
      await settleRefinersForAuthor(workflow, task);
      expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
    }));

  it("re-runs the list from the top once a cleared pointer settles", () =>
    freshRuntime(async (workflow) => {
      patchStageReviewers(workflow, [
        { name: "review", mode: "findings", skill: "implement-review" },
        { name: "final", mode: "findings", skill: "design-review" },
      ]);
      const task = seedPullRequestTask(workflow);
      await settleRefinersForAuthor(workflow, task);
      const first = reviewerOf(workflow);
      workflow.store.updateTask(first.task_id, { status: "done" });
      workflow.store.setArtifactRefinerRun(JOB, null);
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      const second = reviewerOf(workflow);
      expect(second.refiner_index).toBe(0);
      expect(second.task_id).not.toBe(first.task_id);
    }));
});

function tookFlush(workflow: FakeRuntime): boolean {
  const pending = workflow.store.todoRow(TASK)?.flush_schedule ?? null;
  workflow.store.patchTodoRow(TASK, { flush_schedule: null });
  return pending !== null;
}

function afterStart(step: (workflow: FakeRuntime) => Promise<void>): Scenario<FakeRuntime> {
  return scenario(started, async (workflow) => {
    tookFlush(workflow);
    await step(workflow);
  });
}

describe("the board through a review", () => {
  const answered = afterStart(async (workflow) => {
    workflow.codeHostInstance = reviewHost(
      submittedReview({ state: "CHANGES_REQUESTED", body: "BLOCKING: fix the redirect." }),
      [{ path: "src/login.ts", line: 12, body: "This drops the error." }],
    );
    await onReviewerFinished(workflow, reviewerOf(workflow));
  });

  const routed = afterStart(async (workflow) => {
    workflow.store.updateTask(reviewerOf(workflow).task_id, { status: "done" });
    await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
  });

  const handedOver = afterStart(async (workflow) => {
    workflow.codeHostInstance = reviewHost(submittedReview());
    await onReviewerFinished(workflow, reviewerOf(workflow));
  });

  const broken = afterStart(async (workflow) => {
    await onReviewerFailed(workflow, reviewerOf(workflow), "sandbox gone");
  });

  it("asks for an edit when a reviewer starts", () =>
    started((workflow) => {
      expect(tookFlush(workflow)).toBe(true);
    }));

  it("asks for one when a review goes to the author", () =>
    answered((workflow) => {
      expect(tookFlush(workflow)).toBe(true);
    }));

  it("asks for one when the author goes idle", () =>
    routed((workflow) => {
      expect(tookFlush(workflow)).toBe(true);
    }));

  it("asks for one when the artifact reaches the humans", () =>
    handedOver((workflow) => {
      expect(tookFlush(workflow)).toBe(true);
    }));

  it("asks for one when the review could not run", () =>
    broken((workflow) => {
      expect(tookFlush(workflow)).toBe(true);
    }));

  it("coalesces a burst of transitions into one edit", () =>
    started(async (workflow) => {
      tookFlush(workflow);
      const pending = workflow.alarmsFor("flushBoard").length;
      workflow.store.updateTask(reviewerOf(workflow).task_id, { status: "done" });
      await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
      await onReviewerFailed(workflow, reviewerOf(workflow), "sandbox gone");
      expect(workflow.alarmsFor("flushBoard").length - pending).toBe(1);
    }));
});

describe("refinerInFlight", () => {
  it("is false for a reviewer that failed, so a broken one parks nothing", () =>
    started((workflow) => {
      workflow.store.updateTask(reviewerOf(workflow).task_id, { status: "failed" });
      expect(refinerInFlight(workflow, JOB)).toBe(false);
    }));

  it("is true while its reviewer runs", () =>
    started((workflow) => {
      expect(refinerInFlight(workflow, JOB)).toBe(true);
    }));
});

describe("taskQuiet", () => {
  it("is false while a prompt waits for the author", () =>
    freshRuntime((workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.enqueuePrompt(TASK, "fix it");
      expect(taskQuiet(workflow, task)).toBe(false);
    }));

  it("is false while the author's turn runs", () =>
    freshRuntime((workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      expect(taskQuiet(workflow, task)).toBe(false);
    }));

  it("is false while the author waits for its harness session", () =>
    freshRuntime((workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateTask(TASK, { status: "provisioning" });
      expect(taskQuiet(workflow, workflow.store.requireTask(task.task_id))).toBe(false);
    }));

  it("is false while the task waits for its sandbox", () =>
    freshRuntime((workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateTask(TASK, { status: "queued" });
      expect(taskQuiet(workflow, workflow.store.requireTask(task.task_id))).toBe(false);
    }));

  it("is false while the harness session opens", () =>
    freshRuntime((workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.insertRpc(TASK, "session/new", "session_new");
      expect(taskQuiet(workflow, task)).toBe(false);
    }));

  it("is true once the author takes no prompts", () =>
    freshRuntime((workflow) => {
      expect(taskQuiet(workflow, seedPullRequestTask(workflow))).toBe(true);
    }));
});

describe("startRefiner", () => {
  describe("a second reviewer on the same artifact", () => {
    const again = scenario(started, async (workflow) => {
      const first = reviewerOf(workflow);
      workflow.store.updateTask(first.task_id, { status: "done" });
      await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
    });

    it("takes a task id of its own", () =>
      again((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(2);
      }));

    it("points the artifact at the new reviewer", () =>
      again((workflow) => {
        const pointer = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
        expect(workflow.store.refinerRunsOf(JOB).at(-1)?.task_id).toBe(pointer);
      }));

    it("tells the channel nothing", () =>
      again((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("an entry with its own harness and model", () => {
    it("starts the refiner on what the entry declares", () =>
      freshRuntime(async (workflow) => {
        const task = seedPullRequestTask(workflow);
        patchStageReviewers(workflow, [
          {
            name: "second opinion",
            mode: "findings",
            harness: "opencode",
            model: "other-model",
            skill: "design-review",
          },
        ]);
        await startRefiner(workflow, task, 0);
        const run = reviewerOf(workflow);
        expect(run.model).toBe("other-model");
        expect(workflow.store.requireSandbox(run.task_id).harness).toBe("opencode");
      }));
  });
});

describe("onReviewerFinished", () => {
  describe("a review with findings", () => {
    const answered = scenario(started, async (workflow) => {
      workflow.codeHostInstance = reviewHost(
        submittedReview({ state: "CHANGES_REQUESTED", body: "BLOCKING: fix the redirect." }),
        [{ path: "src/login.ts", line: 12, body: "This drops the error." }],
      );
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("sends it to the author", () =>
      answered((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([
          expect.stringContaining("This drops the error."),
        ]);
      }));

    it("keeps the artifact drafted", () =>
      answered((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("keeps the refiner on the artifact, so the open segment survives the run trip", () =>
      answered((workflow) => {
        expect(workflow.store.artifact(JOB)?.refiner_task_id).toBe(reviewerOf(workflow).task_id);
      }));

    it("stores the review on the refiner run's row", () =>
      answered((workflow) => {
        expect(reviewerOf(workflow).result).toMatchObject({
          blocking: true,
          revision: "abc123",
        });
      }));

    it("tells the agent there is nothing to do", () =>
      answered((workflow) => {
        expect(workflow.notes.at(-1)).toMatchObject({
          text: expect.stringContaining("Nothing to do now."),
          wake: "none",
        });
      }));

    it("tells the channel nothing", () =>
      answered((workflow) => {
        expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toEqual([]);
      }));
  });

  describe("a review with nothing in it", () => {
    const clean = scenario(started, async (workflow) => {
      workflow.codeHostInstance = reviewHost(submittedReview());
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("gives the artifact to the humans", () =>
      clean((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says the one line the pull request kind wrote, and nothing about the review", () =>
      clean((workflow) => {
        expect(announcedText(workflow)).toBe(`The pull request is ready for you: ${PR_URL}`);
      }));
  });

  describe("a prompt that reaches the author while the segment's review is being read", () => {
    const caught = scenario(started, async (workflow) => {
      workflow.codeHostInstance = new PromptArrivesDuringRevision(workflow, submittedReview());
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("hands the artifact to nobody, since the author is about to rewrite it", () =>
      caught((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("clears the pointer, so the list re-runs from the top once the author settles", () =>
      caught((workflow) => {
        expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
      }));

    it("sends the author no review", () =>
      caught((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("a review whose head revision the host cannot give", () => {
    const unreadable = scenario(started, async (workflow) => {
      const review = submittedReview();
      workflow.codeHostInstance = new PullUnreadable({
        reviews: { 1: [review] },
        reviewComments: { [review.id]: commentsOf([]) },
      });
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("still settles the artifact", () =>
      unreadable((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));
  });

  describe("a reviewer that filed no review at all", () => {
    const silent = scenario(started, async (workflow) => {
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("gives the artifact to the humans, since nothing holds it", () =>
      silent((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("closes healthy, since nothing went wrong", () =>
      silent((workflow) => {
        expect(announcedText(workflow)).toBe(`The pull request is ready for you: ${PR_URL}`);
      }));
  });

  describe("a segment whose newest revision differs from the merged review", () => {
    const stale = scenario(started, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({
        pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "def456" } })],
        reviews: { 1: [submittedReview({ state: "CHANGES_REQUESTED", commit_id: "abc123" })] },
        reviewComments: {
          501: commentsOf([{ path: "src/login.ts", line: 12, body: "This drops the error." }]),
        },
      });
      await onReviewerFinished(workflow, reviewerOf(workflow));
    });

    it("sends nothing to the author", () =>
      stale((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("re-runs the segment from its first entry", () =>
      stale((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
        expect(reviewerOf(workflow).refiner_index).toBe(0);
      }));

    it("says out loud that the artifact moved", () =>
      stale((workflow) => {
        expect(workflow.lines.some((line) => line.includes("the artifact moved"))).toBe(true);
      }));

    it("leaves the author's review ask unanswered, since the review is about gone code", () =>
      stale((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));

    describe("while the author is working", () => {
      const busy = scenario(started, async (workflow) => {
        workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
        workflow.codeHostInstance = new FakeCodeHost({
          pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "def456" } })],
          reviews: { 1: [submittedReview({ state: "CHANGES_REQUESTED", commit_id: "abc123" })] },
          reviewComments: {
            501: commentsOf([{ path: "src/login.ts", line: 12, body: "This drops the error." }]),
          },
        });
        await onReviewerFinished(workflow, reviewerOf(workflow));
      });

      it("starts nothing and lets the settle path route the artifact", () =>
        busy((workflow) => {
          expect(workflow.store.activeRefinerRuns()).toHaveLength(0);
          expect(workflow.notes).toEqual([]);
        }));
    });
  });

  describe("a reviewer the artifact no longer holds", () => {
    const dropped = scenario(started, async (workflow) => {
      const reviewer = reviewerOf(workflow);
      workflow.store.setArtifactRefinerRun(JOB, "wf_x.9");
      await onReviewerFinished(workflow, reviewer);
    });

    it("leaves the artifact alone", () =>
      dropped((workflow) => {
        expect(workflow.store.artifact(JOB)).toMatchObject({
          status: "drafted",
          refiner_task_id: "wf_x.9",
        });
      }));

    it("says why it was dropped", () =>
      dropped((workflow) => {
        expect(
          workflow.lines.some((line) =>
            line.includes("the artifact no longer holds this reviewer"),
          ),
        ).toBe(true);
      }));
  });

  describe("a reviewer that finished after the humans got the artifact", () => {
    const late = scenario(started, async (workflow) => {
      const reviewer = reviewerOf(workflow);
      workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
      await onReviewerFinished(workflow, reviewer);
    });

    it("announces nothing a second time", () =>
      late((workflow) => {
        expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toEqual([]);
      }));

    it("says the artifact was already past it", () =>
      late((workflow) => {
        expect(workflow.lines.some((line) => line.includes("already ready"))).toBe(true);
      }));
  });

  describe("a finished reviewer whose end event arrives twice", () => {
    it("does nothing the second time", () =>
      started(async (workflow) => {
        const reviewer = reviewerOf(workflow);
        await onReviewerFinished(workflow, reviewer);
        const before = workflow.store.refinerRunsOf(JOB).length;
        await onReviewerFinished(workflow, reviewer);
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(before);
      }));
  });
});

function reviewerFor(workflow: FakeRuntime, index: number) {
  const refinerRunId = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
  const run = workflow.store.requireTask(refinerRunId);
  expect(run.refiner_index).toBe(index);
  return run;
}

async function judgeFinished(workflow: FakeRuntime) {
  const judge = reviewerFor(workflow, 0);
  workflow.store.updateTask(judge.task_id, { summary: JUDGE_CONCLUSION });
  await onReviewerFinished(workflow, judge);
}

describe("a reviewer list with several entries", () => {
  const judgeThenSharedSegment: ReviewerEntry[] = [
    JUDGE_ENTRY,
    { name: "review", mode: "findings", skill: "implement-review" },
    { name: "final", mode: "findings", skill: "design-review" },
  ];

  const opened = scenario(freshRuntime, async (workflow) => {
    patchStageReviewers(workflow, judgeThenSharedSegment);
    stubRulingModel(workflow, 0.02);
    await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
  });

  it("starts the first entry on the first settle", () =>
    opened((workflow) => {
      expect(reviewerFor(workflow, 0).refiner_index).toBe(0);
    }));

  describe("the judge entry approves", () => {
    const advanced = scenario(opened, judgeFinished);

    it("hands the artifact to the next segment without a turn for the author", () =>
      advanced((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.notes).toEqual([]);
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
        expect(reviewerFor(workflow, 1).refiner_index).toBe(1);
      }));

    it("marks the finished entry done", () =>
      advanced((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)[0]?.status).toBe("done");
      }));
  });

  describe("a mid-segment entry hands its review on", () => {
    const mid = scenario(opened, async (workflow) => {
      await judgeFinished(workflow);
      await onReviewerFinished(workflow, reviewerFor(workflow, 1));
    });

    it("starts the last entry of the list", () =>
      mid((workflow) => {
        expect(reviewerFor(workflow, 2).refiner_index).toBe(2);
      }));

    it("keeps the artifact held, since the segment has not settled", () =>
      mid((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("the last entry settles the segment", () => {
    const settled = scenario(opened, async (workflow) => {
      await judgeFinished(workflow);
      await onReviewerFinished(workflow, reviewerFor(workflow, 1));
      await onReviewerFinished(workflow, reviewerFor(workflow, 2));
    });

    it("releases the artifact when nobody filed anything", () =>
      settled((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("keeps every review of the segment on its own row", () =>
      settled((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(3);
      }));
  });

  describe("a mid-segment hand-on while the author is working", () => {
    const twoEntries: ReviewerEntry[] = [
      { name: "review", mode: "findings", skill: "implement-review" },
      { name: "final", mode: "findings", skill: "design-review" },
    ];

    const busy = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, twoEntries);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      const first = reviewerOf(workflow);
      workflow.store.enqueuePrompt(TASK, "a human asked for more work");
      await onReviewerFinished(workflow, first);
    });

    it("starts no next entry on an artifact the author is about to rewrite", () =>
      busy((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
      }));

    it("clears the pointer, so the list re-runs from the top", () =>
      busy((workflow) => {
        expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
      }));

    it("keeps the artifact drafted", () =>
      busy((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("re-runs the list from the top once the author settles", () =>
      busy(async (workflow) => {
        const queued = workflow.store.queue().at(-1);
        if (queued) workflow.store.dequeuePrompt(queued.id);
        workflow.store.updateSandbox(TASK, { prompt_in_flight: 0 });
        await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
        expect(reviewerOf(workflow).refiner_index).toBe(0);
      }));
  });

  describe("a segment where an earlier review is about a moved artifact", () => {
    const twoEntries: ReviewerEntry[] = [
      { name: "review", mode: "findings", skill: "implement-review" },
      { name: "final", mode: "findings", skill: "design-review" },
    ];

    const settled = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, twoEntries);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      const first = reviewerOf(workflow);
      workflow.store.updateTask(first.task_id, {
        result: {
          kind: "review",
          revision: "abc123",
          blocking: false,
          summary: "Fine at r1.",
          findings: [],
        },
      });
      await onReviewerFinished(workflow, first);
      const second = reviewerOf(workflow);
      workflow.store.updateTask(second.task_id, {
        result: {
          kind: "review",
          revision: "def456",
          blocking: false,
          summary: "Fine at r2.",
          findings: [],
        },
      });
      workflow.codeHostInstance = new FakeCodeHost({
        pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "def456" } })],
      });
      await onReviewerFinished(workflow, second);
    });

    it("runs the segment again from its first entry", () =>
      settled((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
        expect(reviewerOf(workflow).refiner_index).toBe(0);
      }));

    it("sends the merged review nowhere, since it mixes revisions", () =>
      settled((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("says out loud that the artifact moved", () =>
      settled((workflow) => {
        expect(workflow.lines.some((line) => line.includes("the artifact moved"))).toBe(true);
      }));
  });

  describe("a shrunk reviewer list", () => {
    it("stops the refiners instead of chaining the last entry forever", () =>
      freshRuntime(async (workflow) => {
        const task = seedPullRequestTask(workflow);
        patchStageReviewers(workflow, [
          { name: "review", mode: "findings", skill: "implement-review" },
        ]);
        await startRefiner(workflow, task, 3);
        expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        expect(announcedText(workflow)).toContain("no longer declares refiner entry 3");
      }));
  });

  describe("the segment's merged review", () => {
    /** Two entries that share one segment, so the segment settles on the last one. */
    const twoEntries: ReviewerEntry[] = [
      { name: "review", mode: "findings", skill: "implement-review" },
      { name: "final", mode: "findings", skill: "design-review" },
    ];

    const merged = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, twoEntries);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      const first = reviewerFor(workflow, 0);
      workflow.store.updateTask(first.task_id, {
        result: storedReview("Two loose ends.", "One", false),
      });
      await onReviewerFinished(workflow, first);
      const second = reviewerFor(workflow, 1);
      workflow.store.updateTask(second.task_id, {
        result: storedReview("One more.", "Two", true),
      });
      await onReviewerFinished(workflow, second);
    });

    it("sends the merged review to the author", () =>
      merged((workflow) => {
        const text = workflow.store
          .queue()
          .map((row) => row.text)
          .join("\n");
        expect(text).toContain("review: Two loose ends.");
        expect(text).toContain("final: One more.");
        expect(text).toContain("One");
        expect(text).toContain("Two");
      }));

    it("blocks when any review of the segment blocks", () =>
      merged((workflow) => {
        expect(
          workflow.lines.some((line) => line.includes("review left 2 findings (blocking)")),
        ).toBe(true);
      }));

    it("keeps the artifact drafted while the author answers", () =>
      merged((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("the merge over a segment that ran twice", () => {
    /** Two entries that share one segment, so each run settles on its last entry. */
    const twoEntries: ReviewerEntry[] = [
      { name: "review", mode: "findings", skill: "implement-review" },
      { name: "final", mode: "findings", skill: "design-review" },
    ];

    const rerun = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, twoEntries);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      const firstRoundReview = reviewerOf(workflow);
      workflow.store.updateTask(firstRoundReview.task_id, {
        started_at: "2026-09-03T10:00:00.000Z",
        result: storedReview("Run one review.", "stale finding", true),
      });
      await onReviewerFinished(workflow, firstRoundReview);
      const firstRoundFinal = reviewerOf(workflow);
      workflow.store.updateTask(firstRoundFinal.task_id, {
        started_at: "2026-09-03T10:00:00.000Z",
        result: storedReview("Run one final.", "stale too", true),
      });
      await onReviewerFinished(workflow, firstRoundFinal);
      for (const row of workflow.store.queue()) workflow.store.dequeuePrompt(row.id);
      workflow.store.updateTask(TASK, { status: "in_review" });
      await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
      const secondRoundReview = reviewerOf(workflow);
      workflow.store.updateTask(secondRoundReview.task_id, {
        result: storedReview("Run two review.", "fresh finding", true),
      });
      await onReviewerFinished(workflow, secondRoundReview);
      const secondRoundFinal = reviewerOf(workflow);
      workflow.store.updateTask(secondRoundFinal.task_id, {
        result: storedReview("Run two final.", "fresh too", true),
      });
      await onReviewerFinished(workflow, secondRoundFinal);
    });

    it("sends only the reviews of the run that just ran", () =>
      rerun((workflow) => {
        const text = workflow.store
          .queue()
          .map((row) => row.text)
          .join("\n");
        expect(text).toContain("review: Run two review.");
        expect(text).toContain("final: Run two final.");
        expect(text).not.toContain("Run one");
      }));

    it("sends one prompt for the segment, not one per run", () =>
      rerun((workflow) => {
        expect(workflow.store.queue()).toHaveLength(1);
      }));
  });
});

function judgeOf(workflow: FakeRuntime) {
  return workflow.store.refinerRunsOf(JOB).findLast((run) => run.refiner_index === 0)!;
}

async function authorTurnEnds(workflow: FakeRuntime) {
  for (const prompt of workflow.store.queue()) workflow.store.dequeuePrompt(prompt.id);
  workflow.store.updateTask(TASK, { status: "in_review" });
  await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
}

function refinerIndexes(workflow: FakeRuntime) {
  return workflow.store.refinerRunsOf(JOB).map((run) => run.refiner_index);
}

describe("a judge entry", () => {
  const entries: ReviewerEntry[] = [
    JUDGE_ENTRY,
    { name: "review", mode: "findings", skill: "implement-review" },
  ];
  const REJECTION = "The change adds a second scheduler. Call schedule() instead.";
  let host: FakeCodeHost;

  function judgeRan(
    rejects: number | Error,
    turnText: string,
    declared: ReviewerEntry[] = entries,
  ): Scenario<FakeRuntime> {
    return scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, declared);
      host = new FakeCodeHost({
        pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } })],
      });
      workflow.codeHostInstance = host;
      stubRulingModel(workflow, rejects);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      workflow.store.updateTask(judgeOf(workflow).task_id, { summary: turnText });
      await onReviewerFinished(workflow, judgeOf(workflow));
    });
  }

  function postedComments() {
    return host.calls.filter((call) => call.method === "commentOnPull").map((call) => call.args);
  }

  describe("a conclusion the decisions model reads as a rejection", () => {
    const rejected = judgeRan(0.97, `I read the diff.\n## Conclusion\n${REJECTION}`);

    it("posts the conclusion on the pull request, signed with the entry, run, and task", () =>
      rejected(() => {
        expect(postedComments()).toEqual([
          ["acme/app", 1, `${REJECTION}\n\nReviewer: alignment · run 1 · task wf_x.2`],
        ]);
      }));

    it("says nothing in the thread", () =>
      rejected((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("prompts the author with the conclusion alone", () =>
      rejected((workflow) => {
        const [prompt] = workflow.store.queue();
        expect(prompt?.task_id).toBe(TASK);
        expect(prompt?.text).toContain("The alignment judge rejected your artifact.");
        expect(prompt?.text).toContain(REJECTION);
        expect(prompt?.text).not.toContain("I read the diff.");
      }));

    it("keeps the entry open on the judge that rejected", () =>
      rejected((workflow) => {
        expect(workflow.store.artifact(JOB)?.refiner_task_id).toBe(judgeOf(workflow).task_id);
        expect(judgeOf(workflow).result).toMatchObject({
          kind: "ruling",
          ruling: "rejected",
          reason: REJECTION,
        });
      }));

    it("starts no turn for the agent", () =>
      rejected((workflow) => {
        expect(workflow.notes.map((note) => note.wake)).toEqual(["none"]);
      }));

    describe("once the author's turn ends", () => {
      const answered = scenario(rejected, authorTurnEnds);

      it("does not run the judge again, and starts the next entry", () =>
        answered((workflow) => {
          expect(refinerIndexes(workflow)).toEqual([0, 1]);
        }));

      it("points the artifact at the next entry and keeps it held", () =>
        answered((workflow) => {
          const pointer = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
          expect(workflow.store.requireTask(pointer).refiner_index).toBe(1);
          expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
        }));

      it("starts no turn for the agent", () =>
        answered((workflow) => {
          expect(workflow.notes.map((note) => note.wake)).toEqual(["none"]);
        }));
    });
  });

  describe("a stage whose only entry is a judge that rejected", () => {
    const rejected = judgeRan(0.97, REJECTION, [JUDGE_ENTRY]);

    describe("once the author's turn ends", () => {
      const answered = scenario(rejected, authorTurnEnds);

      it("hands the artifact to the humans without another refiner run", () =>
        answered((workflow) => {
          expect(refinerIndexes(workflow)).toEqual([0]);
          expect(workflow.store.artifact(JOB)?.status).toBe("ready");
          expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
        }));
    });
  });

  describe("a stage whose only entry is a judge that approved", () => {
    const approved = judgeRan(0.03, JUDGE_CONCLUSION, [JUDGE_ENTRY]);

    it("stores the approval on the judge task", () =>
      approved((workflow) => {
        expect(judgeOf(workflow).result).toMatchObject({ kind: "ruling", ruling: "approved" });
      }));

    describe("and then the artifact reopens and the author's turn ends", () => {
      const reopened = scenario(approved, async (workflow) => {
        workflow.store.advanceArtifact(JOB, ["ready"], "drafted");
        workflow.store.setArtifactRefinerRun(JOB, null);
        await authorTurnEnds(workflow);
      });

      it("hands the artifact to the humans again without running the judge", () =>
        reopened((workflow) => {
          expect(refinerIndexes(workflow)).toEqual([0]);
          expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        }));
    });
  });

  describe("a judge that approved, then an author prompted while the next review runs", () => {
    const threeEntries: ReviewerEntry[] = [
      ...entries,
      { name: "final", mode: "findings", skill: "design-review" },
    ];

    const interrupted = scenario(
      judgeRan(0.03, JUDGE_CONCLUSION, threeEntries),
      async (workflow) => {
        const second = workflow.store
          .refinerRunsOf(JOB)
          .findLast((run) => run.refiner_index === 1)!;
        workflow.store.enqueuePrompt(TASK, "a human asked for more work");
        await onReviewerFinished(workflow, second);
      },
    );

    it("stops the refiners so the list re-runs from the top", () =>
      interrupted((workflow) => {
        expect(refinerIndexes(workflow)).toEqual([0, 1]);
        expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
      }));

    describe("once the author's turn ends", () => {
      const settled = scenario(interrupted, authorTurnEnds);

      it("starts the list at the entry after the judge", () =>
        settled((workflow) => {
          expect(refinerIndexes(workflow)).toEqual([0, 1, 1]);
        }));

      it("keeps the artifact held", () =>
        settled((workflow) => {
          expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
        }));
    });
  });

  describe("a judge that was cancelled before it ruled", () => {
    const cancelled = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, entries);
      await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
      workflow.store.updateTask(judgeOf(workflow).task_id, { status: "cancelled" });
      workflow.store.setArtifactRefinerRun(JOB, null);
    });

    it("has no review", () =>
      cancelled((workflow) => {
        expect(judgeOf(workflow).result).toBeNull();
      }));

    it("runs the judge again when the refiners re-run from the top", () =>
      cancelled(async (workflow) => {
        await authorTurnEnds(workflow);
        expect(refinerIndexes(workflow)).toEqual([0, 0]);
      }));
  });

  describe("a rejection of a set of issues, which has no place for a top level comment", () => {
    const rejected = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, entries);
      stubRulingModel(workflow, 0.97);
      await settleRefinersForAuthor(workflow, seedIssuesTask(workflow));
      workflow.store.updateTask(judgeOf(workflow).task_id, { summary: REJECTION });
      await onReviewerFinished(workflow, judgeOf(workflow));
    });

    it("posts the signed conclusion in the thread", () =>
      rejected((workflow) => {
        expect(workflow.posted).toEqual([
          { type: "info", text: `${REJECTION}\n\nReviewer: alignment · run 1 · task wf_x.2` },
        ]);
      }));

    it("prompts the author with the conclusion", () =>
      rejected((workflow) => {
        expect(workflow.store.queue().map((prompt) => prompt.task_id)).toEqual([TASK]);
      }));
  });

  describe("a conclusion the decisions model reads as an approval", () => {
    const approved = judgeRan(0.03, JUDGE_CONCLUSION);

    it("starts the next entry and posts nothing", () =>
      approved((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB).map((run) => run.refiner_index)).toEqual([0, 1]);
        expect(postedComments()).toEqual([]);
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.notes).toEqual([]);
      }));

    it("records what the ruling cost", () =>
      approved((workflow) => {
        expect(workflow.store.modelUsage().map((row) => row.purpose)).toEqual(["review_ruling"]);
      }));
  });

  for (const [name, rejects, turnText] of [
    ["a probability in the middle band", 0.52, JUDGE_CONCLUSION],
    ["a decisions call that fails", new Error("timeout"), JUDGE_CONCLUSION],
    ["a reviewer that closed with no text", 0.97, ""],
  ] as const) {
    describe(name, () => {
      const undecided = judgeRan(rejects, turnText);

      it("has the agent ask a person, and routes nothing", () =>
        undecided((workflow) => {
          expect(workflow.notes.map((note) => note.wake)).toEqual(["blocked"]);
          expect(workflow.notes[0]?.text).toContain("rule_on_review");
          expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
          expect(workflow.store.queue()).toEqual([]);
          expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
        }));

      it("stays put when the author is settled again", () =>
        undecided(async (workflow) => {
          await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
          expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
          expect(workflow.notes).toHaveLength(1);
        }));
    });
  }
});

describe("onReviewerFinished for a reviewer of issues", () => {
  const reviewed: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
    await settleRefinersForAuthor(workflow, seedIssuesTask(workflow));
  });

  function closedWith(turnText: string) {
    return scenario(reviewed, async (workflow) => {
      const reviewer = reviewerOf(workflow);
      workflow.store.updateTask(reviewer.task_id, { summary: turnText });
      await onReviewerFinished(workflow, workflow.store.requireTask(reviewer.task_id));
    });
  }

  describe("a turn text that reports findings", () => {
    const findings = closedWith(
      ["Read every issue.", "", "Review: findings", "- Issue two has no outcome."].join("\n"),
    );

    it("sends them to the author", () =>
      findings((workflow) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual([
          expect.stringContaining("Issue two has no outcome."),
        ]);
      }));

    it("keeps the artifact drafted", () =>
      findings((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("a turn text that approves", () => {
    const approved = closedWith(["Read every issue.", "", "Review: approved"].join("\n"));

    it("gives the artifact to the humans", () =>
      approved((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says the one line the issues kind wrote", () =>
      approved((workflow) => {
        expect(announcedText(workflow)).toBe(
          `The issues are ready for you, starting at ${ISSUES_URL}`,
        );
      }));
  });

  describe("a turn text with no review line", () => {
    const silent = closedWith("Read every issue and stopped there.");

    it("gives the artifact to the humans, since nothing holds it", () =>
      silent((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("closes healthy, since nothing went wrong", () =>
      silent((workflow) => {
        expect(announcedText(workflow)).toBe(
          `The issues are ready for you, starting at ${ISSUES_URL}`,
        );
      }));
  });
});

describe("onReviewerFailed", () => {
  describe("a reviewer that died while the artifact was held", () => {
    const failed = scenario(started, async (workflow) => {
      await onReviewerFailed(workflow, reviewerOf(workflow), "sandbox gone");
    });

    it("fails open and gives the artifact to the humans", () =>
      failed((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says out loud why no review ran, and gives the url", () =>
      failed((workflow) => {
        expect(announcedText(workflow)).toBe(
          `The reviewer could not run (sandbox gone). ${PR_URL}`,
        );
      }));
  });

  describe("a reviewer of a task with no artifact", () => {
    it("does nothing", () =>
      freshRuntime(async (workflow) => {
        const author = seedTask(workflow, { stage: "implement" });
        const reviewer = seedTask(workflow, {
          task_id: "wf_x.2",
          role: "reviewer",
          job_id: author.job_id,
          refiner_index: 0,
        });
        await onReviewerFailed(workflow, reviewer, "sandbox gone");
        expect(workflow.posted).toEqual([]);
      }));
  });
});
