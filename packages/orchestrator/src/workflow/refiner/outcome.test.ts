import { describe, expect, it } from "bun:test";
import type { Review } from "../../artifact/types";
import { seedPullRequestTask, seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { freshRuntime } from "../../../test/fresh-runtime";
import { scenario, type Scenario } from "../../../test/scenario";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import type { PullRequest } from "@artfct-ai/adapters/code/types";
import { markArtifactReady, reopenChangedArtifact, sendReviewToAuthor } from "./outcome";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const CHAT_KEY = "chat:C1:1.0";
const BOARD_THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

function review(patch: Partial<Review> = {}): Review {
  return {
    kind: "review",
    revision: "abc123",
    blocking: true,
    summary: "Two things.",
    findings: [{ location: "src/login.ts:12", body: "This drops the error." }],
    ...patch,
  };
}

function hostAt(sha: string): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha } })],
  });
}

function readyEvents(workflow: FakeRuntime) {
  return workflow.posted.filter((event) => event.type === "artifact_ready");
}

class HostHoldingTheFirstRevision extends FakeCodeHost {
  private resolveFirstRead?: () => void;
  private readonly firstRead = new Promise<void>((resolve) => {
    this.resolveFirstRead = resolve;
  });
  private reads = 0;

  constructor() {
    super({
      pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha: "abc123" } })],
    });
  }

  answerTheFirstRevision(): void {
    this.resolveFirstRead?.();
  }

  override async getPull(repo: string, number: number): Promise<PullRequest> {
    this.reads += 1;
    if (this.reads === 1) await this.firstRead;
    return super.getPull(repo, number);
  }
}

describe("markArtifactReady", () => {
  const released: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
    workflow.codeHostInstance = hostAt("abc123");
    const task = seedPullRequestTask(workflow);
    await markArtifactReady(workflow, task.job_id, { close: "ready" });
  });

  it("moves the artifact to the humans", () =>
    released((workflow) => {
      expect(workflow.store.artifact(JOB)?.status).toBe("ready");
    }));

  it("takes the reviewer off the artifact", () =>
    released((workflow) => {
      expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
    }));

  it("announces the artifact once, on the one line its kind wrote", () =>
    released((workflow) => {
      expect(readyEvents(workflow)).toEqual([
        {
          type: "artifact_ready",
          job_id: JOB,
          artifact_kind: "pull",
          url: "https://github.com/acme/app/pull/1",
          text: "The pull request is ready for you: https://github.com/acme/app/pull/1",
        },
      ]);
    }));

  it("keeps the revision the humans got", () =>
    released((workflow) => {
      expect(workflow.store.artifact(JOB)?.delivered_revision).toBe("abc123");
    }));

  it("records when the humans first got it", () =>
    released((workflow) => {
      expect(workflow.store.artifact(JOB)?.delivered_to_humans_at).not.toBeNull();
    }));

  it("says in the log that the loop is closed", () =>
    released((workflow) => {
      expect(workflow.lines).toContain("the artifact of job wf_x-1 is handed over");
    }));

  it("starts the idle clock, since the humans are the ones holding it now", () =>
    released((workflow) => {
      expect(workflow.alarmsFor("onIdle")).toHaveLength(1);
    }));

  describe("a second call on the same artifact", () => {
    const again = scenario(released, async (workflow) => {
      await markArtifactReady(workflow, JOB, { close: "ready" });
    });

    it("announces nothing more, since the status already moved", () =>
      again((workflow) => {
        expect(readyEvents(workflow)).toHaveLength(1);
      }));
  });

  describe("an author turn that ends while the host holds the revision of the handover", () => {
    const interleaved: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      const host = new HostHoldingTheFirstRevision();
      workflow.codeHostInstance = host;
      seedPullRequestTask(workflow);
      const handover = markArtifactReady(workflow, JOB, { close: "ready" });
      await reopenChangedArtifact(workflow, JOB);
      await markArtifactReady(workflow, JOB, { close: "ready" });
      host.answerTheFirstRevision();
      await handover;
    });

    it("announces the artifact once", () =>
      interleaved((workflow) => {
        expect(readyEvents(workflow)).toHaveLength(1);
      }));

    it("leaves the artifact with the humans", () =>
      interleaved((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("keeps the revision the humans got", () =>
      interleaved((workflow) => {
        expect(workflow.store.artifact(JOB)?.delivered_revision).toBe("abc123");
      }));
  });

  describe("an artifact the host already accepted", () => {
    const accepted: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      const task = seedPullRequestTask(workflow, {}, { status: "accepted" });
      await markArtifactReady(workflow, task.job_id, { close: "ready" });
    });

    it("announces nothing", () =>
      accepted((workflow) => {
        expect(readyEvents(workflow)).toEqual([]);
      }));

    it("leaves the status where it was", () =>
      accepted((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("accepted");
      }));

    it("keeps no delivered revision", () =>
      accepted((workflow) => {
        expect(workflow.store.artifact(JOB)?.delivered_revision).toBeNull();
      }));
  });

  describe("and then an author turn that changed nothing", () => {
    const unchanged = scenario(released, async (workflow) => {
      workflow.store.insertBoard(JOB, CHAT_KEY, BOARD_THREAD);
      await reopenChangedArtifact(workflow, JOB);
    });

    it("leaves the board where it is", () =>
      unchanged((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(0);
      }));

    it("leaves the artifact with the humans", () =>
      unchanged((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));
  });

  describe("and then an author turn that pushed a new revision", () => {
    const changed = scenario(released, async (workflow) => {
      workflow.codeHostInstance = hostAt("def456");
      workflow.store.insertBoard(JOB, CHAT_KEY, BOARD_THREAD);
      await reopenChangedArtifact(workflow, JOB);
    });

    it("leaves the board where the follow-up put it", () =>
      changed((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(0);
      }));

    it("makes the artifact a draft again", () =>
      changed((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    it("keeps the revision the humans got across reopen", () =>
      changed((workflow) => {
        expect(workflow.store.artifact(JOB)?.delivered_revision).toBe("abc123");
      }));

    it("says why in the log", () =>
      changed((workflow) => {
        expect(workflow.lines).toContain(
          "the artifact of job wf_x-1 changed, so it is a draft again and the refiners run",
        );
      }));
  });

  describe("and then an author turn when the host cannot say the revision", () => {
    const unknown = scenario(released, async (workflow) => {
      workflow.codeHostInstance = new FakeCodeHost({ pulls: [] });
      await reopenChangedArtifact(workflow, JOB);
    });

    it("makes the artifact a draft again, since a change cannot be ruled out", () =>
      unknown((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
      }));

    describe("and a second handover while the host still cannot say", () => {
      let firstAt: string | null | undefined;
      const handedAgain = scenario(unknown, async (workflow) => {
        firstAt = workflow.store.artifact(JOB)?.delivered_to_humans_at;
        await markArtifactReady(workflow, JOB, { close: "ready" });
      });

      it("keeps no revision for the humans", () =>
        handedAgain((workflow) => {
          expect(workflow.store.artifact(JOB)?.delivered_revision).toBeNull();
        }));

      it("keeps the time of the first handover", () =>
        handedAgain((workflow) => {
          expect(firstAt).not.toBeNull();
          expect(workflow.store.artifact(JOB)?.delivered_to_humans_at).toBe(firstAt);
        }));
    });
  });

  describe("a task with no artifact", () => {
    const nothing: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      await markArtifactReady(workflow, seedTask(workflow).job_id, { close: "ready" });
    });

    it("announces nothing", () =>
      nothing((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));
  });

  describe("a blocked close", () => {
    const blocked: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      await markArtifactReady(workflow, seedPullRequestTask(workflow).job_id, {
        close: "blocked",
        reason: "The reviewer could not run (the sandbox died).",
      });
    });

    it("says what went wrong and gives the url", () =>
      blocked((workflow) => {
        expect(readyEvents(workflow)[0]).toMatchObject({
          text: "The reviewer could not run (the sandbox died). https://github.com/acme/app/pull/1",
        });
      }));

    it("still moves the artifact to the humans", () =>
      blocked((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));
  });
});

describe("sendToAuthor", () => {
  const sent: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
    const task = seedPullRequestTask(workflow);
    workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
    const artifact = workflow.store.artifact(JOB)!;
    await sendReviewToAuthor(workflow, task, artifact, review());
  });

  it("queues the findings for the author", () =>
    sent((workflow) => {
      expect(workflow.store.queue().map((row) => row.text)).toEqual([
        expect.stringContaining("This drops the error."),
      ]);
    }));

  it("says in the log how many findings there were, and whether they block", () =>
    sent((workflow) => {
      expect(workflow.lines).toContain("review left 1 findings (blocking)");
    }));

  it("tells the agent the author is answering, and wakes nobody", () =>
    sent((workflow) => {
      expect(workflow.notes.at(-1)).toMatchObject({
        text: expect.stringContaining("left 1 finding on https://github.com/acme/app/pull/1"),
        wake: "none",
      });
    }));

  it("leaves the artifact drafted, since the review is not over", () =>
    sent((workflow) => {
      expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
    }));

  describe("an author that finished before the review arrived", () => {
    const late: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      const task = seedPullRequestTask(workflow, { status: "done" });
      const artifact = workflow.store.artifact(JOB)!;
      await sendReviewToAuthor(workflow, task, artifact, review());
    });

    it("gives the artifact to the humans instead", () =>
      late((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("says the findings are open on the artifact", () =>
      late((workflow) => {
        expect(readyEvents(workflow)[0]).toMatchObject({
          text: expect.stringContaining("They are open on the artifact."),
        });
      }));

    it("queues nothing for a task that cannot take it", () =>
      late((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));
  });

  describe("a review that blocks nothing", () => {
    const soft: Scenario<FakeRuntime> = scenario(freshRuntime, async (workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      const artifact = workflow.store.artifact(JOB)!;
      await sendReviewToAuthor(workflow, task, artifact, review({ blocking: false }));
    });

    it("says so in the log", () =>
      soft((workflow) => {
        expect(workflow.lines).toContain("review left 1 findings (nothing blocking)");
      }));

    it("says so to the agent", () =>
      soft((workflow) => {
        expect(workflow.notes.at(-1)?.text).toContain("blocking nothing");
      }));
  });
});
