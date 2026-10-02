import type { CheckRun } from "@artfct-ai/adapters/code/types";
import {
  FakeCodeHost,
  pullRequest,
  type CodeHostAnswers,
} from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import {
  JUDGE_CONCLUSION,
  JUDGE_ENTRY,
  patchStagePolishers,
  patchStageReviewers,
  stubRulingModel,
  seedPullRequestTask,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import {
  onReviewerFinished,
  settleRefinersForAuthor,
  startRefiner,
} from "../../workflow/refiner/loop";
import { artifactTools } from "./artifact";
import { taskTools } from "./task";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const PR_URL = "https://github.com/acme/app/pull/1";
const call = { toolCallId: "call-1", messages: [], context: {} };

function readHost(answers: CodeHostAnswers = {}): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [
      pullRequest({
        number: 1,
        head: { ref: "artfct/wf_x-1-fix", sha: "abc123" },
        title: "Fix login",
      }),
    ],
    checks: {
      abc123: [
        { name: "test", conclusion: "success", html_url: "" },
        { name: "lint", conclusion: null, html_url: "" },
      ],
    },
    ...answers,
  });
}

class NoChecksCodeHost extends FakeCodeHost {
  override async checkRunsForRef(repo: string, ref: string): Promise<CheckRun[]> {
    throw new Error(
      `github GET /repos/${repo}/commits/${ref}/check-runs: 403 Resource not accessible by integration`,
    );
  }
}

const heldTask: Scenario<FakeRuntime> = scenario(freshRuntime, (workflow) => {
  seedPullRequestTask(workflow);
});

const reviewRunning: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
  await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
});

describe("request_review", () => {
  describe("a held pull request with no open entry", () => {
    let result: string;
    const refused = scenario(heldTask, async (workflow) => {
      const { request_review } = artifactTools(workflow);
      result = toolText(await request_review.execute({ job_id: JOB }, call));
    });

    it("refuses, since there is nothing to re-run", () =>
      refused(() => {
        expect(result).toBe(`No reviewer entry is open on job ${JOB}.`);
      }));

    it("keeps the artifact drafted", () =>
      refused((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("starts no reviewer run", () =>
      refused((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
      }));
  });

  describe("while the author is still working", () => {
    const busy = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
    });

    it("refuses and says the turn end comes back to the agent", () =>
      busy(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(await request_review.execute({ job_id: JOB }, call)).toBe(
          "The author wf_x.1 is still working. You are told when its turn ends.",
        );
      }));

    it("starts no reviewer run", () =>
      busy(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        await request_review.execute({ job_id: JOB }, call);
        expect(workflow.store.activeRefinerRuns()).toHaveLength(0);
      }));
  });

  describe("while a reviewer is running", () => {
    it("refuses and says the findings come back to the agent", () =>
      reviewRunning(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(await request_review.execute({ job_id: JOB }, call)).toBe(
          `A review is already running on job wf_x-1 as ${workflow.store.artifact(JOB)!.refiner_task_id}. You are told what it finds. cancel_task on it stops it.`,
        );
      }));

    it("starts no second reviewer run", () =>
      reviewRunning(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        await request_review.execute({ job_id: JOB }, call);
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));
  });

  describe("a reviewer that reached the review limit", () => {
    const limited = scenario(reviewRunning, (workflow) => {
      workflow.patchConfig({
        orchestrator: { ...workflow.config().orchestrator, max_review_runs: 1 },
      });
      workflow.store.updateTask(workflow.store.artifact(JOB)!.refiner_task_id!, { status: "done" });
    });

    it("refuses and points at finish_review", () =>
      limited(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(toolText(await request_review.execute({ job_id: JOB }, call))).toBe(
          `The reviewers of job ${JOB} reached the limit of 1 runs. Call finish_review to hand the artifact on.`,
        );
      }));

    it("starts no second reviewer run", () =>
      limited(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        await request_review.execute({ job_id: JOB }, call);
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
      }));
  });

  describe("a workflow whose only reviewer belongs to a task that is over", () => {
    const over = scenario(freshRuntime, (workflow) => {
      seedPullRequestTask(workflow, { status: "done" });
      seedTask(workflow, { task_id: "wf_x.2", job_id: JOB, role: "reviewer", refiner_index: 0 });
    });

    it("refuses the task that is over and points at finish_review", () =>
      over(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(await request_review.execute({ job_id: JOB }, call)).toBe(
          "The author wf_x.1 of job wf_x-1 is done, so nobody would answer the findings. Call finish_review instead.",
        );
      }));

    it("refuses a task id it never saw", () =>
      over(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(await request_review.execute({ job_id: "wf_x-9" }, call)).toBe(
          "Job wf_x-9 does not exist.",
        );
      }));
  });

  describe("an artifact whose pointer names a polisher that already finished", () => {
    const evicted = scenario(freshRuntime, async (workflow) => {
      patchStageReviewers(workflow, [
        JUDGE_ENTRY,
        { name: "review", mode: "findings", skill: "implement-review" },
        { name: "final", mode: "findings", skill: "implement-review" },
      ]);
      patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
      const author = seedPullRequestTask(workflow, { status: "in_review" });
      await startRefiner(workflow, author, 3);
      const polisher = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
      workflow.store.updateTask(polisher, { status: "done" });
    });

    it("refuses rather than starting the polisher a second time", () =>
      evicted(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        expect(toolText(await request_review.execute({ job_id: JOB }, call))).toBe(
          `The open entry on job ${JOB} is a polisher, not a reviewer, so there is no segment to re-run. Call finish_review to hand the artifact on.`,
        );
      }));

    it("starts no refiner run", () =>
      evicted(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        await request_review.execute({ job_id: JOB }, call);
        expect(workflow.store.activeRefinerRuns()).toEqual([]);
      }));

    it("lets finish_review hand the artifact to the humans", () =>
      evicted(async (workflow) => {
        const { finish_review } = artifactTools(workflow);
        await finish_review.execute({ job_id: JOB }, call);
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));
  });

  describe("a stage whose reviewer list has several entries", () => {
    const second = scenario(heldTask, async (workflow) => {
      patchStageReviewers(workflow, [
        JUDGE_ENTRY,
        { name: "review", mode: "findings", skill: "implement-review" },
        { name: "final", mode: "findings", skill: "design-review" },
      ]);
      await startRefiner(workflow, workflow.store.requireTask(TASK), 1);
      const running = workflow.store.refinerRunsOf(JOB)[0]!;
      workflow.store.updateTask(running.task_id, { status: "done" });
    });

    it("re-runs the open segment from its first entry, not the whole list", () =>
      second(async (workflow) => {
        const { request_review } = artifactTools(workflow);
        await request_review.execute({ job_id: JOB }, call);
        const started = workflow.store.requireTask(
          workflow.store.artifact(JOB)?.refiner_task_id ?? "",
        );
        expect(started.refiner_index).toBe(1);
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(2);
      }));
  });
});

describe("a polisher running over a held artifact", () => {
  const polishing = scenario(heldTask, async (workflow) => {
    patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
    await startRefiner(workflow, workflow.store.requireTask(TASK), 1);
  });

  const refusal = `comments is changing the artifact of job ${JOB} right now. Nothing routes until it ends.`;

  it("refuses request_review, naming the polisher that runs", () =>
    polishing(async (workflow) => {
      const { request_review } = artifactTools(workflow);
      expect(toolText(await request_review.execute({ job_id: JOB }, call))).toBe(refusal);
    }));

  it("refuses finish_review, naming the polisher that runs", () =>
    polishing(async (workflow) => {
      const { finish_review } = artifactTools(workflow);
      expect(toolText(await finish_review.execute({ job_id: JOB }, call))).toBe(refusal);
    }));

  it("starts no refiner of its own on either refusal", () =>
    polishing(async (workflow) => {
      const { request_review, finish_review } = artifactTools(workflow);
      await request_review.execute({ job_id: JOB }, call);
      await finish_review.execute({ job_id: JOB }, call);
      expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(1);
    }));
});

describe("a running reviewer the agent cancelled", () => {
  const cancelled = scenario(reviewRunning, async (workflow) => {
    const reviewer = workflow.store.artifact(JOB)!.refiner_task_id!;
    await taskTools(workflow).cancel_task.execute({ task_id: reviewer, reason: "hung" }, call);
  });

  it("keeps the artifact a draft that points at the cancelled reviewer", () =>
    cancelled((workflow) => {
      const artifact = workflow.store.artifact(JOB)!;
      expect(artifact.status).toBe("drafted");
      expect(workflow.store.requireTask(artifact.refiner_task_id!).status).toBe("cancelled");
    }));

  it("lets request_review run the entry again as a new reviewer", () =>
    cancelled(async (workflow) => {
      const before = workflow.store.artifact(JOB)!.refiner_task_id;
      await artifactTools(workflow).request_review.execute({ job_id: JOB }, call);
      const after = workflow.store.artifact(JOB)!.refiner_task_id!;
      expect(after).not.toBe(before);
      expect(workflow.store.requireTask(after)).toMatchObject({
        role: "reviewer",
        refiner_index: 0,
      });
    }));

  it("lets finish_review hand the artifact to the humans", () =>
    cancelled(async (workflow) => {
      await artifactTools(workflow).finish_review.execute({ job_id: JOB }, call);
      expect(workflow.store.artifact(JOB)!.status).toBe("ready");
    }));
});

describe("finish_review", () => {
  describe("a held pull request with no open entry", () => {
    let result: string;
    const refused = scenario(heldTask, async (workflow) => {
      const { finish_review } = artifactTools(workflow);
      result = toolText(await finish_review.execute({ job_id: JOB }, call));
    });

    it("refuses, since there is nothing to end", () =>
      refused(() => {
        expect(result).toBe(`No reviewer entry is open on job ${JOB}.`);
      }));

    it("keeps the artifact drafted", () =>
      refused((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("an open segment with entries after it", () => {
    let result: string;
    const handedOn = scenario(heldTask, async (workflow) => {
      patchStageReviewers(workflow, [
        { name: "review", mode: "findings", skill: "implement-review" },
        { name: "final", mode: "findings", skill: "design-review" },
      ]);
      await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
      const running = workflow.store.refinerRunsOf(JOB)[0]!;
      workflow.store.updateTask(running.task_id, { status: "done" });
      const { finish_review } = artifactTools(workflow);
      result = toolText(await finish_review.execute({ job_id: JOB }, call));
    });

    it("hands on to the next declared entry", () =>
      handedOn((workflow) => {
        expect(result).toBe(`The next entry final started on job ${JOB}.`);
        const started = workflow.store.requireTask(
          workflow.store.artifact(JOB)?.refiner_task_id ?? "",
        );
        expect(started.refiner_index).toBe(1);
        expect(started.status).toBe("queued");
      }));

    it("keeps the artifact with the review", () =>
      handedOn((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("announces nothing", () =>
      handedOn((workflow) => {
        expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toEqual([]);
      }));

    it("never skips the rest of the list", () =>
      handedOn((workflow) => {
        expect(workflow.store.refinerRunsOf(JOB)).toHaveLength(2);
      }));
  });

  describe("the last entry of the list", () => {
    let result: string;
    const released = scenario(heldTask, async (workflow) => {
      await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
      const running = workflow.store.refinerRunsOf(JOB)[0]!;
      workflow.store.updateTask(running.task_id, { status: "done" });
      const { finish_review } = artifactTools(workflow);
      result = toolText(await finish_review.execute({ job_id: JOB }, call));
    });

    it("answers that the humans have the artifact", () =>
      released(() => {
        expect(result).toBe(`The humans have the artifact of job ${JOB}.`);
      }));

    it("marks the artifact ready", () =>
      released((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("posts the one line the kind wrote", () =>
      released((workflow) => {
        expect(workflow.posted).toEqual([
          expect.objectContaining({
            type: "artifact_ready",
            url: PR_URL,
            text: `The pull request is ready for you: ${PR_URL}`,
          }),
        ]);
      }));

    describe("on a second finish_review of the same artifact", () => {
      const releasedTwice = scenario(released, async (workflow) => {
        const { finish_review } = artifactTools(workflow);
        result = toolText(await finish_review.execute({ job_id: JOB }, call));
      });

      it("refuses and says the humans already have it", () =>
        releasedTwice(() => {
          expect(result).toBe(
            `The agent review of job ${JOB} is over and the humans have ${PR_URL}.`,
          );
        }));

      it("posts the artifact once", () =>
        releasedTwice((workflow) => {
          expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toHaveLength(
            1,
          );
        }));
    });
  });

  describe("while a reviewer is running", () => {
    it("refuses, since no tool picks which entry runs", () =>
      reviewRunning(async (workflow) => {
        const { finish_review } = artifactTools(workflow);
        expect(await finish_review.execute({ job_id: JOB }, call)).toBe(
          `A review is already running on job wf_x-1 as ${workflow.store.artifact(JOB)!.refiner_task_id}. You are told what it finds. cancel_task on it stops it.`,
        );
      }));

    it("leaves the running reviewer and the artifact alone", () =>
      reviewRunning(async (workflow) => {
        const { finish_review } = artifactTools(workflow);
        await finish_review.execute({ job_id: JOB }, call);
        expect(workflow.store.refinerRunsOf(JOB)[0]?.status).toBe("queued");
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));
  });

  describe("a task with no artifact", () => {
    it("refuses, since there is nothing to hand over", () =>
      freshRuntime(async (workflow) => {
        seedTask(workflow, { task_id: "wf_x.3" });
        const { finish_review } = artifactTools(workflow);
        expect(await finish_review.execute({ job_id: "wf_x-3" }, call)).toBe(
          "Job wf_x-3 has no artifact yet.",
        );
      }));
  });
});

describe("read_artifact", () => {
  describe("a task that recorded no artifact", () => {
    it("says the task has none", () =>
      freshRuntime(async (workflow) => {
        seedTask(workflow);
        const { read_artifact } = artifactTools(workflow);
        expect(await read_artifact.execute({ job_id: JOB }, call)).toBe(
          "Job wf_x-1 has no artifact.",
        );
      }));
  });

  describe("a recorded pull request without a code host", () => {
    it("hands over the url and says the host is not configured", () =>
      heldTask(async (workflow) => {
        const { read_artifact } = artifactTools(workflow);
        expect(await read_artifact.execute({ job_id: JOB }, call)).toBe(
          `The code host is not configured. The pull request is ${PR_URL}.`,
        );
      }));
  });

  describe("a pull request the host answers with its check runs", () => {
    let code: FakeCodeHost;
    let lines: string[];
    const read = scenario(heldTask, async (workflow) => {
      code = readHost();
      workflow.codeHostInstance = code;
      const { read_artifact } = artifactTools(workflow);
      lines = toolText(await read_artifact.execute({ job_id: JOB }, call)).split("\n");
    });

    it("reports the title, the branches, and every check", () =>
      read(() => {
        expect(lines).toEqual([
          "Fix login (open)",
          "Head artfct/wf_x-1-fix -> main. Mergeable: true.",
          "Checks:",
          "- test: success",
          "- lint: pending",
        ]);
      }));

    it("asks the host for the pull request and the checks of its head", () =>
      read(() => {
        expect(code.calls).toEqual([
          { method: "getPull", args: ["acme/app", 1] },
          { method: "checkRunsForRef", args: ["acme/app", "abc123"] },
        ]);
      }));
  });

  describe("a credential without the Checks permission", () => {
    const read = scenario(heldTask, (workflow) => {
      workflow.codeHostInstance = new NoChecksCodeHost({
        pulls: [
          pullRequest({
            number: 1,
            head: { ref: "artfct/wf_x-1-fix", sha: "abc123" },
            title: "Fix login",
          }),
        ],
      });
    });

    it("still reports the pull request and says why the checks are missing", () =>
      read(async (workflow) => {
        const { read_artifact } = artifactTools(workflow);
        const text = toolText(await read_artifact.execute({ job_id: JOB }, call));
        expect(text.split("\n")).toEqual([
          "Fix login (open)",
          "Head artfct/wf_x-1-fix -> main. Mergeable: true.",
          "Checks could not be read: Error: github GET /repos/acme/app/commits/abc123/check-runs: 403 Resource not accessible by integration",
        ]);
      }));
  });

  describe("a host lookup that fails", () => {
    const read = scenario(heldTask, (workflow) => {
      workflow.codeHostInstance = readHost({ failing: true });
    });

    it("reports the failure instead of throwing", () =>
      read(async (workflow) => {
        const { read_artifact } = artifactTools(workflow);
        expect(toolText(await read_artifact.execute({ job_id: JOB }, call))).toMatch(
          /^The code host lookup failed: Error: getPull: boom/,
        );
      }));
  });
});

function rule(workflow: FakeRuntime, input: { ruling: "reject" | "approve"; reason?: string }) {
  return artifactTools(workflow).rule_on_review.execute({ job_id: JOB, ...input }, call);
}

describe("rule_on_review", () => {
  const judgeList = [
    JUDGE_ENTRY,
    { name: "review", mode: "findings" as const, skill: "implement-review" },
  ];

  const judgeRunning: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
    patchStageReviewers(workflow, judgeList);
    workflow.codeHostInstance = readHost();
    await settleRefinersForAuthor(workflow, seedPullRequestTask(workflow));
  });

  const awaitingRuling = scenario(judgeRunning, async (workflow) => {
    stubRulingModel(workflow, 0.5);
    const judge = workflow.store.refinerRunsOf(JOB)[0]!;
    workflow.store.updateTask(judge.task_id, { summary: JUDGE_CONCLUSION });
    await onReviewerFinished(workflow, judge);
  });

  describe("a judge entry that waits for a person's ruling", () => {
    it("hands the artifact to the next entry on approve", () =>
      awaitingRuling(async (workflow) => {
        const result = toolText(await rule(workflow, { ruling: "approve" }));
        expect(result).toBe(`The next entry review started on job ${JOB}.`);
        expect(workflow.store.refinerRunsOf(JOB).map((run) => run.refiner_index)).toEqual([0, 1]);
      }));

    it("sends the person's reason to the author on reject", () =>
      awaitingRuling(async (workflow) => {
        await rule(workflow, { ruling: "reject", reason: "Use the SDK scheduler." });
        expect(workflow.store.queue().map((prompt) => prompt.text)).toEqual([
          expect.stringContaining("Use the SDK scheduler."),
        ]);
      }));

    it("refuses a reject with no reason", () =>
      awaitingRuling(async (workflow) => {
        const result = toolText(await rule(workflow, { ruling: "reject" }));
        expect(result).toBe("A rejection needs the person's reason. Ask them for it.");
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("refuses a second ruling after a rejection", () =>
      awaitingRuling(async (workflow) => {
        await rule(workflow, { ruling: "reject", reason: "Use the SDK scheduler." });
        const result = toolText(await rule(workflow, { ruling: "approve" }));
        expect(result).toContain("already has a rejection");
      }));

    it("keeps request_review and finish_review off the entry", () =>
      awaitingRuling(async (workflow) => {
        const { request_review, finish_review } = artifactTools(workflow);
        const refusal =
          "The open entry is a judge entry, and code routes it. A person's ruling goes through rule_on_review.";
        expect(toolText(await request_review.execute({ job_id: JOB }, call))).toBe(refusal);
        expect(toolText(await finish_review.execute({ job_id: JOB }, call))).toBe(refusal);
      }));
  });

  describe("a judge reviewer that still runs", () => {
    it("refuses, since code rules when it ends", () =>
      judgeRunning(async (workflow) => {
        const result = toolText(await rule(workflow, { ruling: "approve" }));
        expect(result).toContain("The judge review still runs");
      }));
  });

  describe("a judge reviewer the agent cancelled", () => {
    const cancelled = scenario(judgeRunning, async (workflow) => {
      const judge = workflow.store.artifact(JOB)!.refiner_task_id!;
      await taskTools(workflow).cancel_task.execute({ task_id: judge, reason: "hung" }, call);
    });

    it("lets request_review run the entry again", () =>
      cancelled(async (workflow) => {
        await artifactTools(workflow).request_review.execute({ job_id: JOB }, call);
        expect(workflow.store.refinerRunsOf(JOB).map((run) => run.refiner_index)).toEqual([0, 0]);
      }));

    it("takes a person's approval in its place", () =>
      cancelled(async (workflow) => {
        await rule(workflow, { ruling: "approve" });
        expect(workflow.store.refinerRunsOf(JOB).at(-1)?.refiner_index).toBe(1);
      }));
  });

  describe("a findings entry", () => {
    it("refuses, since there is nothing to rule on", () =>
      reviewRunning(async (workflow) => {
        const result = toolText(await rule(workflow, { ruling: "approve" }));
        expect(result).toBe(
          `No judge entry is open on job ${JOB}, so there is nothing to rule on.`,
        );
      }));
  });
});
