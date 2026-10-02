import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import {
  fakeConnection,
  JUDGE_ENTRY,
  patchStagePolishers,
  patchStageReviewers,
  seedPolisherRun,
  seedPullRequestTask,
  seedReviewerRun,
  seedTask,
  sentMethods,
  type FakeRuntime,
  type FakeSocket,
} from "../../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../../test/scenario";
import {
  firstPromptText,
  promptTask,
  RECONNECT_CEILING_MS,
  sendPrompt,
  taskContext,
} from "./prompt-queue";

const TASK = "wf_x.1";
const JOB = "wf_x-1";

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

type Prompted = { workflow: FakeRuntime; socket: FakeSocket };

function promptedOverBridge(sandbox: Parameters<typeof seedTask>[2]): Scenario<Prompted> {
  return (run) =>
    freshRuntime(async (workflow) => {
      const task = seedTask(workflow, {}, sandbox);
      const socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      await promptTask(workflow, task, "hello");
      await run({ workflow, socket });
    });
}

const queued: Scenario<Prompted> = (run) =>
  freshRuntime(async (workflow) => {
    const task = seedTask(workflow, {}, { session_id: null });
    workflow.store.insertRpc(TASK, "initialize", "initialize");
    const socket = fakeConnection(TASK, 1);
    workflow.sockets.push(socket.connection);
    await promptTask(workflow, task, "hello");
    await run({ workflow, socket });
  });

describe("drainQueue", () => {
  describe("a prompt during the ACP handshake", () => {
    it("leaves the sandbox alone", () =>
      queued(({ workflow }) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("sends nothing to the harness", () =>
      queued(({ socket }) => {
        expect(socket.sent).toEqual([]);
      }));

    it("keeps the prompt in the queue", () =>
      queued(({ workflow }) => {
        expect(workflow.store.queue().map((row) => row.text)).toEqual(["hello"]);
      }));

    it("leaves the task working on its generation", () =>
      queued(({ workflow }) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "working" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 1 });
      }));
  });

  describe("a prompt while the sandbox provisions", () => {
    const provisioning = scenario(freshRuntime, (workflow) =>
      promptTask(workflow, seedTask(workflow, { status: "provisioning" }), "hello"),
    );

    it("leaves the sandbox alone", () =>
      provisioning((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("keeps the prompt in the queue", () =>
      provisioning((workflow) => {
        expect(workflow.store.queue()).toHaveLength(1);
      }));
  });

  describe("a prompt soon after the bridge closed", () => {
    const waiting = scenario(freshRuntime, (workflow) =>
      promptTask(
        workflow,
        seedTask(workflow, {}, { session_id: "s1", bridge_closed_at: secondsAgo(5) }),
        "hello",
      ),
    );

    it("leaves the sandbox alone", () =>
      waiting((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([]);
      }));

    it("names the task and generation on the retry", () =>
      waiting((workflow) => {
        expect(workflow.alarmsFor("retryQueue")[0]?.payload).toEqual({
          task_id: TASK,
          generation: 1,
        });
      }));

    it("retries within the reconnect window", () =>
      waiting((workflow) => {
        expect(workflow.alarmsFor("retryQueue")[0]?.delay).toBeLessThanOrEqual(
          RECONNECT_CEILING_MS / 1000 + 1,
        );
      }));

    it("keeps the prompt in the queue", () =>
      waiting((workflow) => {
        expect(workflow.store.queue()).toHaveLength(1);
      }));
  });

  describe("a prompt soon after the container was closed under the task", () => {
    const woken = scenario(freshRuntime, (workflow) =>
      promptTask(
        workflow,
        seedTask(workflow, {}, { session_id: null, bridge_closed_at: secondsAgo(5) }),
        "hello",
      ),
    );

    it("starts the sandbox now, because there is no session to reconnect to", () =>
      woken((workflow) => {
        expect(workflow.sandboxProvider.calls).toContain(`start ${TASK}`);
      }));

    it("waits for no reconnect", () =>
      woken((workflow) => {
        expect(workflow.alarmsFor("retryQueue")).toEqual([]);
      }));
  });

  describe("a prompt long after the bridge closed", () => {
    const woken = scenario(freshRuntime, (workflow) =>
      promptTask(
        workflow,
        seedTask(workflow, {}, { session_id: "s1", bridge_closed_at: secondsAgo(60) }),
        "hello",
      ),
    );

    it("wakes the sandbox", () =>
      woken((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`start ${TASK}`]);
      }));

    it("provisions the task again on a new generation", () =>
      woken((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "provisioning" });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          generation: 2,
          session_id: null,
        });
      }));

    it("forgets when the bridge closed", () =>
      woken((workflow) => {
        expect(workflow.store.requireSandbox(TASK).bridge_closed_at).toBeNull();
      }));
  });

  describe("a prompt with the harness connected", () => {
    const sent = promptedOverBridge({ session_id: "s1" });

    it("sends the prompt to the harness", () =>
      sent(({ socket }) => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));

    it("marks the turn in flight", () =>
      sent(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));

    it("arms the no-progress timer", () =>
      sent(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).no_progress_schedule).toBe(
          workflow.alarmsFor("onNoProgress")[0]!.id,
        );
      }));

    it("arms the wall clock of the turn", () =>
      sent(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).wall_schedule).toBe(
          workflow.alarmsFor("onWallClock")[0]!.id,
        );
      }));

    it("arms the keep-alive timer", () =>
      sent(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).keepalive_schedule).toBe(
          workflow.alarmsFor("keepSandboxAlive")[0]!.id,
        );
      }));

    it("empties the queue", () =>
      sent(({ workflow }) => {
        expect(workflow.store.queue()).toHaveLength(0);
      }));
  });
});

const sent: Scenario<FakeRuntime> = (run) =>
  freshRuntime(async (workflow) => {
    seedPullRequestTask(workflow);
    workflow.store.updateSandbox(TASK, { session_id: "s1" });
    workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
    workflow.sockets.push(fakeConnection(TASK, 1).connection);
    await sendPrompt(workflow, workflow.store.requireTask(TASK), "more work");
    await run(workflow);
  });

describe("sendPrompt to an author whose artifact the humans have", () => {
  it("leaves the artifact with the humans until the turn shows a change", () =>
    sent((workflow) => {
      expect(workflow.store.artifact(JOB)?.status).toBe("ready");
    }));
});

function judgeText(workflow: FakeRuntime): string {
  patchStageReviewers(workflow, [JUDGE_ENTRY]);
  return firstPromptText(workflow, seedReviewerRun(workflow));
}

describe("firstPromptText", () => {
  describe("a reviewer run on its parent's artifact", () => {
    it("names the artifact under review", () =>
      freshRuntime((workflow) => {
        expect(firstPromptText(workflow, seedReviewerRun(workflow))).toContain("acme/app/pull/1");
      }));

    it("reads the pull request the way the polisher does", () =>
      freshRuntime((workflow) => {
        const { read } = workflow.artifact("pull").instructions;
        expect(firstPromptText(workflow, seedReviewerRun(workflow))).toContain(read);
      }));

    it("tells the reviewer how to submit the review", () =>
      freshRuntime((workflow) => {
        expect(firstPromptText(workflow, seedReviewerRun(workflow))).toContain(
          '1. `pull_request_review_write` with `method: "create"`',
        );
      }));

    it("gives the reviewer the line that names its entry, run, and task", () =>
      freshRuntime((workflow) => {
        expect(firstPromptText(workflow, seedReviewerRun(workflow))).toContain(
          "Reviewer: Code review · run 1 · task wf_x.2",
        );
      }));

    it("counts an earlier run of the same entry", () =>
      freshRuntime((workflow) => {
        const first = seedReviewerRun(workflow);
        workflow.store.updateTask(first.task_id, { status: "done" });
        workflow.clock = workflow.now() + 60_000;
        const second = seedTask(workflow, {
          task_id: "wf_x.3",
          role: "reviewer",
          stage: "implement",
          job_id: first.job_id,
          refiner_index: 0,
        });
        expect(firstPromptText(workflow, second)).toContain("run 2 · task wf_x.3");
      }));

    it("says the entry is gone when the config no longer declares it", () =>
      freshRuntime((workflow) => {
        const reviewer = seedReviewerRun(workflow);
        patchStageReviewers(workflow, []);
        expect(firstPromptText(workflow, reviewer)).toBe(
          "The artifact or the reviewer entry you were started for is gone. Say so in one line and stop.",
        );
      }));
  });

  describe("a reviewer run on a judge entry", () => {
    it("tells the reviewer how to read the pull request", () =>
      freshRuntime((workflow) => {
        expect(judgeText(workflow)).toContain("gh pr diff <number>");
      }));

    it("tells the reviewer to post nothing and close with its conclusion", () =>
      freshRuntime((workflow) => {
        const text = judgeText(workflow);
        expect(text).toContain("Post nothing on the artifact.");
        expect(text).toContain("## Conclusion");
      }));

    it("leaves out the review steps, the signature, and the ruling question", () =>
      freshRuntime((workflow) => {
        const text = judgeText(workflow);
        expect(text).not.toContain("pull_request_review_write");
        expect(text).not.toContain("Reviewer: alignment");
        expect(text).not.toContain("It asks for a rewrite.");
      }));
  });

  describe("a polisher run on its parent's artifact", () => {
    const polishing = scenario(freshRuntime, (workflow) => {
      patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
    });

    it("tells it to run the entry skill as its whole role", () =>
      polishing((workflow) => {
        const text = firstPromptText(workflow, seedPolisherRun(workflow));
        expect(text).toContain("Read the `technical-writer` skill");
        expect(text).toContain("You file no review.");
      }));

    it("names the artifact and how the kind is changed in place", () =>
      polishing((workflow) => {
        const text = firstPromptText(workflow, seedPolisherRun(workflow));
        expect(text).toContain("acme/app/pull/1");
        expect(text).toContain("Change the files on your branch and push to that branch.");
      }));

    it("names the repository, the branch it commits to, and how to read the pull request", () =>
      polishing((workflow) => {
        const polisher = seedPolisherRun(workflow);
        const text = firstPromptText(workflow, polisher);
        expect(text).toContain("cloned at the current directory");
        expect(text).toContain(
          `You are on branch \`${workflow.store.requireJob(polisher.job_id).branch}\`.`,
        );
        expect(text).toContain("gh pr diff <number>");
      }));

    it("reads the pull request the way the reviewer does", () =>
      polishing((workflow) => {
        const { read } = workflow.artifact("pull").instructions;
        expect(firstPromptText(workflow, seedPolisherRun(workflow))).toContain(read);
      }));

    it("runs on a page with the page kind's own read and change text", () =>
      polishing((workflow) => {
        const polisher = seedPolisherRun(workflow);
        workflow.store.upsertArtifact({
          job_id: polisher.job_id,
          kind: "page",
          external_url: "https://www.notion.so/Design-0123456789abcdef0123456789abcdef",
          ref: { kind: "page", page_id: "0123456789abcdef0123456789abcdef" },
        });
        const { read, change } = workflow.artifact("page").instructions;
        const text = firstPromptText(workflow, polisher);
        expect(text).toContain(`## How to read the artifact\n${read}`);
        expect(text).toContain(`## How to change the artifact\n${change}`);
      }));

    it("asks it for the repository's lint and not its tests", () =>
      polishing((workflow) => {
        const text = firstPromptText(workflow, seedPolisherRun(workflow));
        expect(text).toContain("run the repository's lint after you finish your edits");
        expect(text).toContain("Do not run any tests.");
      }));

    it("says the entry is gone when the config no longer declares it", () =>
      polishing((workflow) => {
        const polisher = seedPolisherRun(workflow);
        patchStagePolishers(workflow, []);
        expect(firstPromptText(workflow, polisher)).toBe(
          "The artifact or the polisher entry you were started for is gone. Say so in one line and stop.",
        );
      }));
  });

  describe("an author task", () => {
    it("tells it to run the stage skill the way its harness invokes one", () =>
      freshRuntime((workflow) => {
        const task = seedTask(workflow, { stage: "implement" });
        expect(firstPromptText(workflow, task)).toContain("Read the `implement` skill");
      }));
  });

  describe("a job that works from the artifact of a researched job", () => {
    const PRECEDING_PAYLOAD = '{"findings":[{"file":"src/session.ts","line":40}]}';
    const OWN_PAYLOAD = '{"findings":[{"file":"src/login.ts","line":12}]}';
    const workingFromArtifact = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", stage: "design", status: "done" });
      workflow.store.updateJobResearchPayload("wf_x-1", PRECEDING_PAYLOAD);
    });

    it("gives its author the research behind the input artifact and its own", () =>
      workingFromArtifact((workflow) => {
        const author = seedTask(workflow, {
          task_id: "wf_x.2",
          stage: "implement",
          preceding_job_id: "wf_x-1",
        });
        workflow.store.updateJobResearchPayload("wf_x-2", OWN_PAYLOAD);
        const text = firstPromptText(workflow, author);
        expect(text).toContain(`## Research behind the input artifact`);
        expect(text).toContain(PRECEDING_PAYLOAD);
        expect(text).toContain(OWN_PAYLOAD);
      }));

    it("gives its researcher the research behind the input artifact", () =>
      workingFromArtifact((workflow) => {
        const researcher = seedTask(workflow, {
          task_id: "wf_x.2",
          stage: "implement",
          role: "researcher",
          preceding_job_id: "wf_x-1",
        });
        expect(firstPromptText(workflow, researcher)).toContain(PRECEDING_PAYLOAD);
      }));
  });

  describe("a job that works from the artifact of a job with a selection", () => {
    const workingFromChoice = scenario(freshRuntime, (workflow) => {
      seedTask(workflow, { task_id: "wf_x.1", stage: "design", status: "done" });
      workflow.store.updateJobSelection("wf_x-1", "Rotate the token");
    });

    it("carries the selection in the task context", () =>
      workingFromChoice((workflow) => {
        const author = seedTask(workflow, {
          task_id: "wf_x.2",
          stage: "implement",
          preceding_job_id: "wf_x-1",
        });
        expect(taskContext(workflow, author).preceding_selection).toBe("Rotate the token");
      }));

    it("gives its author the selection", () =>
      workingFromChoice((workflow) => {
        const author = seedTask(workflow, {
          task_id: "wf_x.2",
          stage: "implement",
          preceding_job_id: "wf_x-1",
        });
        const text = firstPromptText(workflow, author);
        expect(text).toContain("## Selection behind the input artifact");
        expect(text).toContain("Rotate the token");
      }));
  });

  describe("a job that works from the artifact of a job with no selection", () => {
    it("carries no selection in the task context", () =>
      freshRuntime((workflow) => {
        seedTask(workflow, { task_id: "wf_x.1", stage: "design", status: "done" });
        const author = seedTask(workflow, {
          task_id: "wf_x.2",
          stage: "implement",
          preceding_job_id: "wf_x-1",
        });
        expect(taskContext(workflow, author).preceding_selection).toBeNull();
      }));
  });

  describe("a job that works from a request", () => {
    it("gives its author no research behind an input artifact", () =>
      freshRuntime((workflow) => {
        const author = seedTask(workflow, { stage: "implement" });
        expect(firstPromptText(workflow, author)).not.toContain(
          "## Research behind the input artifact",
        );
      }));
  });
});
