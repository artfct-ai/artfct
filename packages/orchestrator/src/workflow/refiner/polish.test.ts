import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { describe, expect, it } from "bun:test";
import {
  fakeConnection,
  patchStagePolishers,
  patchStageReviewers,
  seedPullRequestTask,
  type FakeRuntime,
  type FakeSocket,
} from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import type { RefinerEntry, ReviewerEntry } from "../../config/refiner";
import { cancelTask, failTask } from "../lifecycle";
import { drainQueue, promptTask } from "../task/harness/prompt-queue";
import { onTurnEnd } from "../task/harness/turn";
import { advanceArtifactPastEntry, settleRefinersForAuthor, startRefiner } from "./loop";
import { endPolisherRun, polisherRefusal, settlePolisherTurn } from "./polish";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const PR_URL = "https://github.com/acme/app/pull/1";

const review: ReviewerEntry = { name: "review", mode: "findings", skill: "implement-review" };
const comments: RefinerEntry = { name: "comments", skill: "technical-writer" };
const naming: RefinerEntry = { name: "naming", skill: "code-cleaner" };

function currentRunOf(workflow: FakeRuntime) {
  const refinerRunId = workflow.store.artifact(JOB)?.refiner_task_id ?? "";
  return workflow.store.requireTask(refinerRunId);
}

function announcedText(workflow: FakeRuntime): string {
  const announced = workflow.posted.find((event) => event.type === "artifact_ready");
  return announced?.type === "artifact_ready" ? announced.text : "";
}

function stageWithPolishers(polishers: RefinerEntry[]): Scenario<FakeRuntime> {
  return scenario(freshRuntime, (workflow) => {
    patchStageReviewers(workflow, [review]);
    patchStagePolishers(workflow, polishers);
  });
}

function polishersOf(workflow: FakeRuntime): string[] {
  return workflow.store
    .refinerRunsOf(JOB)
    .filter((run) => run.role === "polisher")
    .map((run) => run.task_id);
}

async function runAuthorTurn(workflow: FakeRuntime, text: string): Promise<void> {
  workflow.store.updateSandbox(TASK, { session_id: "s2" });
  const author = workflow.store.requireTask(TASK);
  workflow.sockets.push(
    fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation).connection,
  );
  await promptTask(workflow, author, text);
  await onTurnEnd(workflow, workflow.store.requireTask(TASK), "end_turn");
}

describe("a stage whose reviewers settled", () => {
  const polishing = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await advanceArtifactPastEntry(workflow, author, 0);
  });

  it("starts the polisher at the index after the reviewers", () =>
    polishing((workflow) => {
      expect(currentRunOf(workflow)).toMatchObject({
        role: "polisher",
        refiner_index: 1,
        job_id: JOB,
        status: "queued",
      });
    }));

  it("points the artifact at the polisher and keeps it a draft", () =>
    polishing((workflow) => {
      expect(workflow.store.artifact(JOB)).toMatchObject({
        status: "drafted",
        refiner_task_id: currentRunOf(workflow).task_id,
      });
    }));

  it("says on the log which refiner it started", () =>
    polishing((workflow) => {
      expect(workflow.lines).toContain(
        `polish as ${currentRunOf(workflow).task_id}: entry 1 comments`,
      );
    }));

  it("adds no artifact of its own", () =>
    polishing((workflow) => {
      expect(workflow.store.artifact(currentRunOf(workflow).task_id)).toBeNull();
    }));
});

describe("the author's container while a polisher runs", () => {
  let socket: FakeSocket;
  const closed = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    workflow.store.updateSandbox(TASK, { session_id: "s1" });
    socket = fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation);
    workflow.sockets.push(socket.connection);
    workflow.store.enqueuePrompt(TASK, "the checks failed");
    await startRefiner(workflow, author, 1);
  });

  it("destroys the author's container", () =>
    closed((workflow) => {
      expect(workflow.sandboxProvider.calls).toContain(`destroy ${TASK}`);
    }));

  it("closes the author's bridge socket", () =>
    closed(() => {
      expect(socket.closes).toEqual([{ code: 1000, reason: "a polisher has the artifact" }]);
    }));

  it("forgets the session that went with the container", () =>
    closed((workflow) => {
      expect(workflow.store.requireSandbox(TASK).session_id).toBeNull();
    }));

  it("leaves the author row and its status alone", () =>
    closed((workflow) => {
      expect(workflow.store.requireTask(TASK).status).toBe("in_review");
    }));

  it("leaves the author's queued prompts alone", () =>
    closed((workflow) => {
      expect(workflow.store.queue().map((row) => row.text)).toEqual(["the checks failed"]);
    }));

  it("sends nothing to the author while the polisher holds its artifact", () =>
    closed(async (workflow) => {
      expect(await drainQueue(workflow, workflow.store.requireTask(TASK))).toBe(false);
      expect(workflow.sandboxProvider.calls).not.toContain(`start ${TASK}`);
    }));

  it("keeps a paused author paused", () =>
    closed(async (workflow) => {
      workflow.store.updateTask(TASK, { paused_at: "2026-09-03T10:00:00.000Z" });
      await promptTask(workflow, workflow.store.requireTask(TASK), "another word");
      expect(workflow.store.requireTask(TASK).paused_at).not.toBeNull();
      expect(workflow.store.queue()).toHaveLength(2);
    }));

  it("refuses request_review and finish_review, naming the polisher", () =>
    closed((workflow) => {
      expect(polisherRefusal(workflow, workflow.store.requireTask(TASK))).toBe(
        `comments is changing the artifact of job ${JOB} right now. Nothing routes until it ends.`,
      );
    }));
});

describe("a polisher whose turn ended", () => {
  const settled = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
    await endPolisherRun(workflow, currentRunOf(workflow), { ended: "turn" });
  });

  it("gives the artifact to the humans", () =>
    settled((workflow) => {
      expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      expect(announcedText(workflow)).toBe(`The pull request is ready for you: ${PR_URL}`);
    }));

  it("clears the pointer and finishes the polisher", () =>
    settled((workflow) => {
      expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
      expect(workflow.store.activeRefinerRuns()).toEqual([]);
    }));

  it("destroys the polisher's own container", () =>
    settled((workflow) => {
      expect(workflow.sandboxProvider.calls).toContain("destroy wf_x.2");
    }));
});

describe("a polisher that went quiet on a revision whose checks failed", () => {
  const failures = [{ name: "unit", conclusion: "failure", detail: "", url: null }];

  function polisherOnFailedChecks(setup: (workflow: FakeRuntime) => void): Scenario<FakeRuntime> {
    return scenario(stageWithPolishers([comments]), async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({
        pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } })],
        commitChecks: { abc123: { state: "failed", failures } },
      });
      const author = seedPullRequestTask(workflow, { status: "in_review" });
      await startRefiner(workflow, author, 1);
      workflow.store.updateTask(currentRunOf(workflow).task_id, { status: "working" });
      setup(workflow);
      await settlePolisherTurn(workflow, currentRunOf(workflow));
    });
  }

  describe("for the first time", () => {
    const sentBack = polisherOnFailedChecks(() => {});

    it("gets the failure, not the author", () =>
      sentBack((workflow) => {
        expect(workflow.store.queue()).toMatchObject([
          { task_id: "wf_x.2", text: expect.stringContaining("- unit: failure") },
        ]);
      }));

    it("keeps the artifact, which stays a draft", () =>
      sentBack((workflow) => {
        expect(workflow.store.artifact(JOB)).toMatchObject({
          status: "drafted",
          refiner_task_id: "wf_x.2",
        });
      }));
  });

  describe("after it already answered them", () => {
    const stillFailing = polisherOnFailedChecks((workflow) => {
      workflow.store.markEventSeen({ id: `checks_failed:${JOB}:abc123`, kind: "ci_event" });
    });

    it("ends the lists and gives the humans the artifact with the reason", () =>
      stillFailing((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        expect(announcedText(workflow)).toContain("The checks still fail after wf_x.2 answered");
      }));
  });
});

describe("a stage with two polishers", () => {
  const chained = scenario(stageWithPolishers([comments, naming]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
    await endPolisherRun(workflow, currentRunOf(workflow), { ended: "turn" });
  });

  it("starts the second one and holds the artifact back", () =>
    chained((workflow) => {
      expect(currentRunOf(workflow)).toMatchObject({ role: "polisher", refiner_index: 2 });
      expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
    }));

  it("tells the humans nothing yet", () =>
    chained((workflow) => {
      expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toEqual([]);
    }));
});

describe("a polisher that did not run", () => {
  const stopped = scenario(stageWithPolishers([comments, naming]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
  });

  it("gives the artifact to the humans with the reason when it fails", () =>
    stopped(async (workflow) => {
      await failTask(workflow, currentRunOf(workflow), "sandbox start failed");
      expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      expect(announcedText(workflow)).toBe(
        `The polish stopped early (sandbox start failed). The branch may hold part of its changes. ${PR_URL}`,
      );
    }));

  it("ends the rest of the list rather than starting the next polisher", () =>
    stopped(async (workflow) => {
      await failTask(workflow, currentRunOf(workflow), "sandbox start failed");
      expect(workflow.store.activeRefinerRuns()).toEqual([]);
      expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
    }));

  it("gives the artifact to the humans with the reason when it is cancelled", () =>
    stopped(async (workflow) => {
      await cancelTask(workflow, currentRunOf(workflow), "the workflow failed");
      expect(announcedText(workflow)).toBe(
        `The polish stopped early (the polisher was cancelled: the workflow failed). The branch may hold part of its changes. ${PR_URL}`,
      );
    }));
});

describe("an author prompted while a polisher held its artifact", () => {
  const released = scenario(stageWithPolishers([comments, naming]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
    workflow.store.enqueuePrompt(TASK, "the checks failed");
    await endPolisherRun(workflow, currentRunOf(workflow), { ended: "turn" });
  });

  it("stops the rest of the refiners, because the author is about to move the artifact", () =>
    released((workflow) => {
      expect(workflow.store.artifact(JOB)).toMatchObject({
        status: "drafted",
        refiner_task_id: null,
      });
    }));

  it("wakes the author's sandbox for the prompt it held", () =>
    released((workflow) => {
      expect(workflow.sandboxProvider.calls).toContain(`start ${TASK}`);
    }));
});

describe("a polisher the artifact no longer points at", () => {
  const dropped = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
    const polisher = currentRunOf(workflow);
    workflow.store.setArtifactRefinerRun(JOB, null);
    workflow.store.enqueuePrompt(TASK, "the checks failed");
    await endPolisherRun(workflow, polisher, { ended: "turn" });
  });

  it("leaves the artifact where it is", () =>
    dropped((workflow) => {
      expect(workflow.store.artifact(JOB)).toMatchObject({
        status: "drafted",
        refiner_task_id: null,
      });
      expect(workflow.lines).toContain(
        "polish dropped: the artifact no longer holds this polisher",
      );
    }));

  it("still drains the author's queue", () =>
    dropped((workflow) => {
      expect(workflow.sandboxProvider.calls).toContain(`start ${TASK}`);
    }));
});

describe("an author turn that restarts the lists after a polisher settled", () => {
  const refixed = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await advanceArtifactPastEntry(workflow, author, 0);
    await endPolisherRun(workflow, currentRunOf(workflow), { ended: "turn" });
    await runAuthorTurn(workflow, "the checks failed");
  });

  it("makes the artifact a draft again and runs the reviewers from the top", () =>
    refixed((workflow) => {
      expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      expect(currentRunOf(workflow)).toMatchObject({ role: "reviewer", refiner_index: 0 });
    }));

  it("runs the polisher again once those reviewers settle", () =>
    refixed(async (workflow) => {
      await advanceArtifactPastEntry(workflow, workflow.store.requireTask(TASK), 0);
      expect(polishersOf(workflow)).toHaveLength(2);
      expect(currentRunOf(workflow)).toMatchObject({ role: "polisher", refiner_index: 1 });
    }));
});

describe("a stage of polishers only, whose artifact a later author turn reopens", () => {
  const reopened = scenario(freshRuntime, async (workflow) => {
    patchStageReviewers(workflow, []);
    patchStagePolishers(workflow, [comments]);
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 0);
    await endPolisherRun(workflow, currentRunOf(workflow), { ended: "turn" });
    await runAuthorTurn(workflow, "the checks failed");
  });

  it("runs its only entry again rather than handing the artifact on", () =>
    reopened((workflow) => {
      expect(polishersOf(workflow)).toHaveLength(2);
      expect(workflow.store.artifact(JOB)).toMatchObject({ status: "drafted" });
      expect(currentRunOf(workflow)).toMatchObject({ role: "polisher", refiner_index: 0 });
    }));
});

describe("an eviction between the write that ended a polisher and the hand-on", () => {
  const resettled = scenario(stageWithPolishers([comments]), async (workflow) => {
    const author = seedPullRequestTask(workflow, { status: "in_review" });
    await startRefiner(workflow, author, 1);
    workflow.store.updateTask(currentRunOf(workflow).task_id, { status: "done" });
    await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
  });

  it("clears the pointer and runs the list from the top", () =>
    resettled((workflow) => {
      expect(currentRunOf(workflow)).toMatchObject({ role: "reviewer", refiner_index: 0 });
      expect(workflow.lines).toContain(
        "a finished polisher still holds the artifact. the refiners re-run.",
      );
    }));
});
