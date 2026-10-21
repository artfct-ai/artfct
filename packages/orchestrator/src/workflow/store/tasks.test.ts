import { describe, expect, it } from "bun:test";
import { Notifier } from "../../notify/notifier";
import { freshStore } from "../../../test/fresh-store";
import { scenario } from "../../../test/scenario";
import { DELIVERY_ERROR } from "./schema";
import { TURN_TEXT_CHARS, type NewJob, type NewTask, type WorkflowStore } from "./tasks";
import { jobInputKey } from "./input-key";

const job: NewJob = {
  job_id: "j1",
  stage: "implement",
  issue_id: null,
  issue_key: null,
  input_kind: "request",
  input_key: jobInputKey({ kind: "request", text: "Fix the login redirect." }),
  preceding_job_id: null,
  branch: null,
  brief: "",
};

const task: NewTask = {
  task_id: "t1",
  job_id: "j1",
  role: "author",
  model: "mock",
  sandbox: { harness: "opencode", bridge_token: "secret" },
};

function insertAuthor(store: WorkflowStore, taskId: string, jobId: string, stage = "implement") {
  store.insertJob({ ...job, job_id: jobId, stage });
  store.insertTask({ ...task, task_id: taskId, job_id: jobId });
}

function textsOf(store: WorkflowStore): string[] {
  return store.queue().map((row) => row.text);
}

const artifact = {
  kind: "pull",
  external_url: "u",
  ref: { kind: "pull", repo: "acme/app", number: 1 },
} as const;

describe("WorkflowStore", () => {
  describe("a task written through the migrated schema", () => {
    const written = scenario(freshStore, (store) => {
      insertAuthor(store, "t1", "j1");
      store.updateTask("t1", { status: "working" });
      store.updateSandbox("t1", { nudged: 1 });
      store.appendTurnText("t1", "hello ");
      store.appendTurnText("t1", "world");
    });

    it("round-trips the updated columns", () =>
      written((store) => {
        expect(store.requireTask("t1")).toMatchObject({ status: "working" });
        expect(store.requireSandbox("t1")).toMatchObject({ nudged: 1 });
      }));

    it("joins the appended turn text", () =>
      written((store) => {
        expect(store.requireSandbox("t1").turn_text).toBe("hello world");
      }));

    it("starts with the bridge open", () =>
      written((store) => {
        expect(store.requireSandbox("t1").bridge_closed_at).toBeNull();
      }));

    it("answers null for a task id it never saw", () =>
      written((store) => {
        expect(store.task("missing")).toBeNull();
      }));

    it("costs nothing before a task reports usage", () =>
      written((store) => {
        expect(store.workflowCost()).toBe(0);
      }));

    it("holds no selection on a new job", () =>
      written((store) => {
        expect(store.requireJob("j1").selection).toBeNull();
      }));

    describe("once a person's selection is stored", () => {
      const selected = scenario(written, (store) => {
        store.updateJobSelection("j1", "Split the table");
      });

      it("keeps the selection on the job", () =>
        selected((store) => {
          expect(store.requireJob("j1").selection).toBe("Split the table");
        }));
    });
  });

  describe("a model-call task", () => {
    const modelCall = scenario(freshStore, (store) => {
      store.insertJob(job);
      store.insertTask({ ...task, sandbox: null });
    });

    it("has a task row", () =>
      modelCall((store) => {
        expect(store.requireTask("t1").status).toBe("queued");
      }));

    it("has no sandbox row", () =>
      modelCall((store) => {
        expect(store.sandbox("t1")).toBeNull();
      }));
  });

  describe("a turn longer than the text cap", () => {
    const longTurn = scenario(freshStore, (store) => {
      insertAuthor(store, "t1", "j1");
      store.appendTurnText("t1", "x".repeat(TURN_TEXT_CHARS));
      store.appendTurnText("t1", "tail");
    });

    it("keeps the text at the cap", () =>
      longTurn((store) => {
        expect(store.requireSandbox("t1").turn_text).toHaveLength(TURN_TEXT_CHARS);
      }));

    it("keeps the tail and drops the head", () =>
      longTurn((store) => {
        expect(store.requireSandbox("t1").turn_text.endsWith("tail")).toBe(true);
      }));
  });

  describe("previous artifacts", () => {
    const twoDoneJobs = scenario(freshStore, (store) => {
      insertAuthor(store, "t1", "j1");
      insertAuthor(store, "t2", "j2", "design");
      store.upsertArtifact({ job_id: "j1", ...artifact });
      store.upsertArtifact({ job_id: "j2", ...artifact });
      store.updateTask("t1", { status: "done" });
      store.updateTask("t2", { status: "done" });
      store.advanceArtifact("j2", ["drafted"], "accepted");
    });

    it("lists the other done job's artifact with its stage", () =>
      twoDoneJobs((store) => {
        expect(store.previousArtifacts("j1").map((row) => row.stage)).toEqual(["design"]);
      }));

    it("excludes the job's own artifact", () =>
      twoDoneJobs((store) => {
        expect(store.previousArtifacts("j2").map((row) => row.stage)).toEqual(["implement"]);
      }));
  });

  describe("artifact lookup by ref", () => {
    const finishedTask = scenario(freshStore, (store) => {
      insertAuthor(store, "t1", "j1");
      store.updateTask("t1", { status: "failed", started_at: "2026-01-01T00:00:00.000Z" });
      store.upsertArtifact({ job_id: "j1", ...artifact });
    });

    it("finds the finished job's artifact", () =>
      finishedTask((store) => {
        expect(store.artifactByPull("acme/app", 1)?.job_id).toBe("j1");
      }));

    it("answers null for a pull request no artifact carries", () =>
      finishedTask((store) => {
        expect(store.artifactByPull("acme/app", 9)).toBeNull();
      }));

    it("keys the artifact by its ref", () =>
      finishedTask((store) => {
        expect(store.artifact("j1")?.ref_key).toBe("pull:acme/app#1");
      }));

    describe("with a page artifact of another job", () => {
      const withPage = scenario(finishedTask, (store) => {
        insertAuthor(store, "t2", "j2");
        store.upsertArtifact({
          job_id: "j2",
          kind: "page",
          external_url: "https://docs.test/page-7",
          ref: { kind: "page", page_id: "page-7" },
        });
      });

      it("finds the page by its id", () =>
        withPage((store) => {
          expect(store.artifactByPage("page-7")?.job_id).toBe("j2");
        }));

      it("still finds the pull request under its own job", () =>
        withPage((store) => {
          expect(store.artifactByPull("acme/app", 1)?.job_id).toBe("j1");
        }));
    });

    describe("with a newer running job on the same pull request", () => {
      const runningTask = scenario(finishedTask, (store) => {
        insertAuthor(store, "t2", "j2");
        store.updateTask("t2", { status: "working", started_at: "2026-01-02T00:00:00.000Z" });
        store.upsertArtifact({ job_id: "j2", ...artifact });
      });

      it("prefers the running job", () =>
        runningTask((store) => {
          expect(store.artifactByPull("acme/app", 1)?.job_id).toBe("j2");
        }));

      it("lists the pull request once among the open artifacts, under the running job", () =>
        runningTask((store) => {
          expect(store.openArtifacts().map((row) => row.job_id)).toEqual(["j2"]);
        }));

      describe("once both jobs are finished", () => {
        const bothFinished = scenario(runningTask, (store) => {
          store.updateTask("t2", { status: "cancelled" });
        });

        it("answers the newest job, the last word on the pull request", () =>
          bothFinished((store) => {
            expect(store.artifactByPull("acme/app", 1)?.job_id).toBe("j2");
          }));
      });
    });
  });

  describe("rpc ids", () => {
    const twoRpcs = scenario(freshStore, (store) => {
      store.insertRpc("t1", "initialize", "initialize");
      store.insertRpc("t1", "session/new", "session_new");
    });

    it("allocates ids in sequence", () =>
      freshStore((store) => {
        expect(store.insertRpc("t1", "initialize", "initialize")).toBe(1);
        expect(store.insertRpc("t1", "session/new", "session_new")).toBe(2);
      }));

    it("reports the handshake pending while its rpcs are open", () =>
      twoRpcs((store) => {
        expect(store.handshakePending("t1")).toBe(true);
      }));

    it("hands an rpc out once with its purpose and method", () =>
      twoRpcs((store) => {
        expect(store.takeRpc(2, "t1")).toEqual({ purpose: "session_new", method: "session/new" });
        expect(store.takeRpc(2, "t1")).toBeNull();
      }));

    it("reports the handshake done once every rpc is taken", () =>
      twoRpcs((store) => {
        store.takeRpc(2, "t1");
        store.takeRpc(1, "t1");
        expect(store.handshakePending("t1")).toBe(false);
      }));
  });

  describe("event dedupe", () => {
    it("admits an event the first time", () =>
      freshStore((store) => {
        expect(store.markEventSeen("e1")).toBe(true);
      }));

    it("rejects an event it has seen", () =>
      freshStore((store) => {
        store.markEventSeen("e1");
        expect(store.markEventSeen("e1")).toBe(false);
      }));
  });

  describe("outbox", () => {
    it("stores the target and payload as JSON", () =>
      freshStore((store) => {
        store.writeOutbox({ channel: "chat", kind: "post", target: { ch: "C1" }, payload: [1] });
        expect(store.outbox()[0]).toMatchObject({ target: { ch: "C1" }, payload: [1] });
      }));
  });

  describe("post counting", () => {
    const target = { ch: "C1" };
    const payload = {};

    it("counts nothing on an empty outbox", () =>
      freshStore((store) => {
        expect(store.postedCount()).toBe(0);
      }));

    describe("entries no person reads", () => {
      const unread = scenario(freshStore, (store) => {
        store.writeOutbox({ channel: "board", kind: "create", target, payload });
        store.writeOutbox({ channel: "internal", kind: "progress", target, payload });
        store.writeOutbox({ channel: "tracker", kind: "issue_update", target, payload });
        store.writeOutbox({ channel: "tracker", kind: DELIVERY_ERROR, target, payload });
        store.writeOutbox({ channel: "chat", kind: DELIVERY_ERROR, target, payload });
        store.writeOutbox({ channel: "chat", kind: "acknowledge", target, payload });
        store.writeOutbox({ channel: "chat", kind: "working", target, payload });
        store.writeOutbox({ channel: "chat", kind: "release", target, payload });
      });

      it("counts none of them", () =>
        unread((store) => {
          expect(store.postedCount()).toBe(0);
        }));

      describe("mixed with entries a person reads", () => {
        const mixed = scenario(unread, (store) => {
          store.writeOutbox({ channel: "chat", kind: "answer", target, payload });
          store.writeOutbox({ channel: "tracker", kind: "response", target, payload });
          store.writeOutbox({ channel: "documents", kind: "info", target, payload });
          store.writeOutbox({ channel: "tracker", kind: "error", target, payload });
        });

        it("counts only the rows a person reads, a Linear error message among them", () =>
          mixed((store) => {
            expect(store.postedCount()).toBe(4);
          }));
      });
    });

    describe("a failure the notifier told a person about", () => {
      const toldFailure = scenario(freshStore, async (store) => {
        const notifier = new Notifier(
          { tracker: async () => null, chat: null, documents: async () => null },
          (entry) => store.writeOutbox(entry),
        );
        await notifier.post(
          { source: "tracker", session_id: "s1", issue_id: "i1" },
          { type: "failed", job_id: "j1", reason: "the sandbox died" },
        );
      });

      it("lands in the outbox as an error message", () =>
        toldFailure((store) => {
          expect(store.outbox().map((row) => row.kind)).toEqual(["error"]);
        }));

      it("counts as a post, unlike a call that failed", () =>
        toldFailure((store) => {
          expect(store.postedCount()).toBe(1);
        }));
    });
  });

  describe("prompt queue", () => {
    const twoQueued = scenario(freshStore, (store) => {
      store.enqueuePrompt("t1", "a", "workflow");
      store.enqueuePrompt("t2", "b", "workflow");
    });

    it("clears one task's prompts and keeps the other's", () =>
      twoQueued((store) => {
        store.clearPromptQueue("t1");
        expect(store.queue().map((row) => row.task_id)).toEqual(["t2"]);
      }));

    it("puts a prompt queued first ahead of the prompts that wait", () =>
      twoQueued((store) => {
        store.enqueuePromptFirst("t1", "first");
        expect(store.peekPrompt("t1")?.text).toBe("first");
        expect(store.queue().map((row) => row.text)).toEqual(["first", "a", "b"]);
      }));
  });

  describe("steered instructions", () => {
    const steered = scenario(freshStore, (store) => {
      store.enqueuePrompt("t1", "out", "instruction");
      store.enqueuePrompt("t1", "taken", "instruction");
      store.enqueuePrompt("t1", "waiting", "instruction");
      store.enqueuePrompt("t1", "check results", "workflow");
      store.enqueuePrompt("t2", "other task", "instruction");
      const [out, taken] = store.waitingInstructions("t1");
      store.steerPrompt(out!.id, 10);
      store.steerPrompt(taken!.id, 11);
      store.takeSteer(11);
    });

    it("waits only for the instructions without a steer", () =>
      steered((store) => {
        expect(store.waitingInstructions("t1").map((row) => row.text)).toEqual(["waiting"]);
        expect(store.peekPrompt("t1")?.text).toBe("waiting");
      }));

    it("takes only the steer its answer names", () =>
      steered((store) => {
        expect(store.steers().map((row) => [row.rpc_id, row.status])).toEqual([
          [10, "out"],
          [11, "taken"],
        ]);
      }));

    it("drops the taken instruction at a turn end and lets the out one wait", () =>
      steered((store) => {
        store.dropTakenPrompts("t1");
        expect(textsOf(store)).toEqual(["out", "waiting", "check results", "other task"]);
        expect(store.steers()).toEqual([]);
        expect(store.peekPrompt("t1")?.text).toBe("out");
      }));

    it("returns every steered instruction when the turn is cancelled or lost", () =>
      steered((store) => {
        store.clearRpc("t1");
        expect(textsOf(store)).toHaveLength(5);
        expect(store.steers()).toEqual([]);
        expect(store.peekPrompt("t1")?.text).toBe("out");
      }));

    it("holds an instruction a prompt carried as taken", () =>
      steered((store) => {
        const waiting = store.peekPrompt("t1")!;
        store.holdTakenPrompt(waiting.id, 12);
        store.dropTakenPrompts("t1");
        expect(textsOf(store)).toEqual(["out", "check results", "other task"]);
      }));

    it("lets the instruction of a declined steer wait again", () =>
      steered((store) => {
        store.declineSteer(10);
        store.declineSteer(11);
        expect(store.steers().map((row) => [row.rpc_id, row.status])).toEqual([[11, "taken"]]);
        expect(store.peekPrompt("t1")?.text).toBe("out");
      }));

    it("counts the prompts that wait apart from the steered and taken instructions", () =>
      steered((store) => {
        expect(store.promptCounts("t1")).toEqual({ waiting: 2, steered: 1, taken: 1 });
        expect(store.promptCounts("t2")).toEqual({ waiting: 1, steered: 0, taken: 0 });
      }));

    it("drops the steers with the queue", () =>
      steered((store) => {
        store.clearPromptQueue("t1");
        expect(textsOf(store)).toEqual(["other task"]);
        expect(store.steers()).toEqual([]);
      }));
  });

  describe("a job that works from the artifact of an earlier job", () => {
    const linked = scenario(freshStore, (store) => {
      store.insertJob(job);
      store.insertJob({ ...job, job_id: "j2", preceding_job_id: "j1" });
    });

    it("records the job whose artifact it works from", () =>
      linked((store) => {
        expect(store.requireJob("j2").preceding_job_id).toBe("j1");
      }));

    it("leaves the earlier job with no preceding job", () =>
      linked((store) => {
        expect(store.requireJob("j1").preceding_job_id).toBeNull();
      }));
  });

  describe("a job with only a researcher task", () => {
    const researching = scenario(freshStore, (store) => {
      store.insertJob(job);
      store.insertTask({ ...task, task_id: "t1", role: "researcher" });
    });

    it("has no author task", () =>
      researching((store) => {
        expect(store.authorTask("j1")).toBeNull();
      }));

    it("is held by its researcher", () =>
      researching((store) => {
        expect(store.authorOrResearcherTaskOf("j1").task_id).toBe("t1");
      }));

    it("counts the researcher as an active job task", () =>
      researching((store) => {
        expect(store.activeAuthorAndResearcherTasks().map((row) => row.task_id)).toEqual(["t1"]);
      }));

    it("counts no refiner run", () =>
      researching((store) => {
        expect(store.activeRefinerRuns()).toEqual([]);
        expect(store.refinerRunsOf("j1")).toEqual([]);
      }));

    it("holds no research payload yet", () =>
      researching((store) => {
        expect(store.requireJob("j1").research_payload).toBeNull();
      }));

    describe("once the researcher stored its research payload", () => {
      const researched = scenario(researching, (store) => {
        store.updateJobResearchPayload("j1", '{"files":["src/login.ts:12"]}');
      });

      it("keeps the payload on the job", () =>
        researched((store) => {
          expect(store.requireJob("j1").research_payload).toBe('{"files":["src/login.ts:12"]}');
        }));
    });

    describe("once the researcher is done and the author started", () => {
      const authoring = scenario(researching, (store) => {
        store.updateTask("t1", { status: "done" });
        store.insertTask({ ...task, task_id: "t2" });
      });

      it("is held by its author", () =>
        authoring((store) => {
          expect(store.authorOrResearcherTaskOf("j1").task_id).toBe("t2");
        }));

      it("counts only the author as an active job task", () =>
        authoring((store) => {
          expect(store.activeAuthorAndResearcherTasks().map((row) => row.task_id)).toEqual(["t2"]);
        }));
    });
  });

  describe("a job with an author and a reviewer run", () => {
    const reviewing = scenario(freshStore, (store) => {
      insertAuthor(store, "t1", "j1");
      store.insertTask({ ...task, task_id: "t2", role: "reviewer", refiner_index: 0 });
    });

    it("lists the reviewer as its refiner run", () =>
      reviewing((store) => {
        expect(store.refinerRunsOf("j1").map((row) => row.task_id)).toEqual(["t2"]);
        expect(store.activeRefinerRuns().map((row) => row.task_id)).toEqual(["t2"]);
      }));

    it("counts only the author as an active job task", () =>
      reviewing((store) => {
        expect(store.activeAuthorAndResearcherTasks().map((row) => row.task_id)).toEqual(["t1"]);
      }));
  });
});
