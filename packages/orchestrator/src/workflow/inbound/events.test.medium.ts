import type { InboundEvent, PullDetail, ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { TaskEvent } from "../task/events";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Notifier, type ChannelClients, type PostOptions } from "../../notify/notifier";
import type { Workflow } from "../../workflow";
import { failWorkflow } from "../lifecycle";
import { type Scenario, scenario } from "../../../test/scenario";

type Outbox = Array<{ kind: string; payload: Record<string, unknown> }>;

async function outboxOf(workflow: Workflow): Promise<Outbox> {
  const debug = (await workflow.debug()) as { outbox: Outbox };
  return debug.outbox;
}

const NO_CHANNELS: ChannelClients = {
  tracker: async () => null,
  chat: null,
  documents: async () => null,
};

class RecordingNotifier extends Notifier {
  options: PostOptions[] = [];
  releases: Array<{ finished: boolean; title?: string }> = [];

  override async post(
    _target: ReplyTarget,
    _event: TaskEvent,
    options: PostOptions = {},
  ): Promise<void> {
    this.options.push(options);
  }

  override async release(_target: ReplyTarget, finished: boolean, title?: string): Promise<void> {
    this.releases.push({ finished, title });
  }
}

const chatThread: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };

const start: InboundEvent = {
  id: "evt-start",
  kind: "start",
  actor: { person_id: "p1", email: "dev@acme.test", display_name: "Dev" },
  bindings: [],
  links: [],
  text: "fix the flaky test",
  reply_to: chatThread,
  acknowledge: { message: "1.0", user: "U1" },
};

const prClosed: InboundEvent = {
  ...start,
  id: "evt-pr",
  kind: "pr_event",
  actor: null,
  reply_to: undefined,
  acknowledge: undefined,
  text: "PR closed",
  pull: { repo: "acme/app", number: 7, action: "closed" },
};

let opened = 0;

function createdFrom(
  event: InboundEvent,
  endedWorkflowId: string | null = null,
): Scenario<Workflow> {
  return async (run) => {
    opened += 1;
    const name = `wf_events_${opened}`;
    const stub = env.Workflow.getByName(name);
    await runInDurableObject(stub, async (workflow) => {
      await workflow.create(name, event, endedWorkflowId);
      await workflow.settle();
      await run(workflow);
    });
  };
}

const freshWorkflow = createdFrom(start);

function firstTaskId(workflow: Workflow): string {
  return `${workflow.state.workflow_id}.1`;
}

function firstJobId(workflow: Workflow): string {
  return `${workflow.state.workflow_id}-1`;
}

describe("acknowledge", () => {
  describe("a start from a Slack thread, then a prompt and a repeat of it", () => {
    const prompted = scenario(freshWorkflow, async (workflow) => {
      await workflow.handle({
        ...start,
        id: "evt-prompt",
        kind: "prompt",
        text: "also add a test",
        acknowledge: { message: "1.5", user: "U1" },
      });
      await workflow.handle({ ...start, id: "evt-prompt", kind: "prompt" });
    });

    it("marks each Slack message as received once, before the agent is told", () =>
      prompted(async (workflow) => {
        const acks = (await outboxOf(workflow)).filter((entry) => entry.kind === "acknowledge");
        expect(acks.map((entry) => entry.payload)).toEqual([
          { message: "1.0", user: "U1", title: "fix the flaky test" },
          { message: "1.5", user: "U1", title: "fix the flaky test" },
        ]);
      }));
  });

  describe("a message after the plan named the workflow", () => {
    const named = scenario(freshWorkflow, async (workflow) => {
      workflow.patchState({ name: "Flaky checkout test" });
      await workflow.handle({
        ...start,
        id: "evt-named",
        kind: "prompt",
        acknowledge: { message: "2.0", user: "U1" },
      });
    });

    it("shows the name instead of the first line the person typed", () =>
      named(async (workflow) => {
        const acks = (await outboxOf(workflow)).filter((entry) => entry.kind === "acknowledge");
        expect(acks.at(-1)?.payload).toEqual({
          message: "2.0",
          user: "U1",
          title: "Flaky checkout test",
        });
      }));
  });

  describe("a bare mention, which Slack maps to an empty title and empty text", () => {
    let recorder: RecordingNotifier;
    const bare = createdFrom({ ...start, id: "evt-bare", title: "", text: "" });

    it("titles the request rather than storing the empty string", () =>
      bare((workflow) => {
        expect(workflow.state.request.title).toBe("task");
      }));

    it("sends that title to Slack, never an empty one", () =>
      bare(async (workflow) => {
        recorder = new RecordingNotifier(NO_CHANNELS, () => {});
        workflow.notifier = recorder;
        await workflow.release();
        expect(recorder.releases).toEqual([{ finished: false, title: "task" }]);
      }));
  });

  describe("a start with no Slack reply target", () => {
    const fromTracker = createdFrom({
      ...start,
      reply_to: { source: "tracker", session_id: "s1", issue_id: "i1" },
    });

    it("acknowledges nothing", () =>
      fromTracker(async (workflow) => {
        const acks = (await outboxOf(workflow)).filter((entry) => entry.kind === "acknowledge");
        expect(acks).toEqual([]);
      }));
  });
});

describe("release", () => {
  describe("a review event with no task to act on, which only leaves a note", () => {
    let kinds: string[];
    const handled = scenario(freshWorkflow, async (workflow) => {
      const before = (await outboxOf(workflow)).length;
      await workflow.handle({
        ...start,
        id: "evt-review",
        kind: "feedback",
        text: "LGTM",
        pull: { repo: "acme/app", number: 9, action: "review", reviewer: "dev" },
        acknowledge: { message: "1.5", user: "U1" },
      });
      kinds = (await outboxOf(workflow)).slice(before).map((entry) => entry.kind);
    });

    it("acknowledges the message and releases the thread", () =>
      handled(() => {
        expect(kinds).toEqual(["acknowledge", "release"]);
      }));
  });

  describe("an event the workflow answers itself", () => {
    let kinds: string[];
    const handled = scenario(freshWorkflow, async (workflow) => {
      const before = (await outboxOf(workflow)).length;
      await workflow.handle({
        ...start,
        id: "evt-cancel",
        kind: "prompt",
        text: "cancel",
        acknowledge: { message: "1.5", user: "U1" },
      });
      kinds = (await outboxOf(workflow)).slice(before).map((entry) => entry.kind);
    });

    it("posts its own answer", () =>
      handled(() => {
        expect(kinds).toContain("info");
      }));

    it("leaves the thread alone", () =>
      handled(() => {
        expect(kinds).not.toContain("release");
      }));
  });
});

const humanReviewPull: PullDetail = {
  repo: "acme/app",
  number: 7,
  action: "review",
  reviewer: "octocat",
  review_id: 5_116_787_321,
  comments: [{ path: "config/artfct.yaml", line: 29, body: "This is overspecified" }],
};

const humanReview: InboundEvent = {
  ...start,
  id: "github:delivery-1",
  kind: "feedback",
  reply_to: undefined,
  acknowledge: undefined,
  text: "",
  bindings: [{ source: "code_pull", repo: "acme/app", number: 7 }],
  pull: humanReviewPull,
};

async function logOf(workflow: Workflow): Promise<string[]> {
  const debug = (await workflow.debug()) as { log: Array<{ line: string }> };
  return debug.log.map((row) => row.line);
}

async function wakesOf(workflow: Workflow): Promise<string[]> {
  return (await logOf(workflow)).filter((line) => line.startsWith("agent wake"));
}

type Transcript = Array<{ message: { role: string; content: unknown } }>;

async function inboxOf(workflow: Workflow): Promise<string[]> {
  await workflow.settle();
  const debug = (await workflow.debug()) as {
    inbox: Array<{ text: string }>;
    transcript: Transcript;
  };
  const read = debug.transcript
    .filter((row) => row.message.role === "user")
    .map((row) => JSON.stringify(row.message.content));
  return [...read, ...debug.inbox.map((row) => row.text)];
}

const reviewedTask = scenario(freshWorkflow, (workflow) => {
  const taskId = firstTaskId(workflow);
  const jobId = firstJobId(workflow);
  workflow.store.insertJob({
    job_id: jobId,
    stage: "implement",
    issue_id: null,
    issue_key: null,
    input_key: null,
    preceding_job_id: null,
    branch: null,
    brief: "",
  });
  workflow.store.insertTask({
    task_id: taskId,
    job_id: jobId,
    role: "author",
    sandbox: { harness: "opencode", bridge_token: "secret" },
    model: "mock",
  });
  workflow.store.updateTask(taskId, { status: "in_review" });
  workflow.store.upsertArtifact({
    job_id: jobId,
    kind: "pull",
    external_url: "https://github.com/acme/app/pull/7",
    ref: { kind: "pull", repo: "acme/app", number: 7 },
  });
});

type Ack = Awaited<ReturnType<Workflow["handle"]>>;

describe("human reviews", () => {
  describe("a review that carries comments", () => {
    let ack: Ack;
    const reviewed = scenario(reviewedTask, async (workflow) => {
      ack = await workflow.handle(humanReview);
    });

    it("takes the webhook", () =>
      reviewed(() => {
        expect(ack).toEqual({ ok: true });
      }));

    it("tells the agent who reviewed and how many comments came with it", () =>
      reviewed(async (workflow) => {
        const note = (await inboxOf(workflow)).find((text) => text.includes("Dev reviewed"));
        expect(note).toContain(
          `Dev reviewed the artifact of job ${firstJobId(workflow)} and left 1 comment.`,
        );
      }));

    it("says the system sent it to nobody, and hands the agent what was said", () =>
      reviewed(async (workflow) => {
        const note = (await inboxOf(workflow)).find((text) => text.includes("Dev reviewed"));
        expect(note).toContain("sent it to nobody");
        expect(note).toContain("This is overspecified");
      }));

    it("logs the review against the task, so the author turn is traceable", () =>
      reviewed(async (workflow) => {
        expect(await logOf(workflow)).toContain("Dev reviewed");
      }));

    it("wakes the agent, since a person is waiting on the workflow", () =>
      reviewed(async (workflow) => {
        expect(await logOf(workflow)).toContain("agent wake: human");
      }));

    describe("redelivered with the delivery id GitHub keeps", () => {
      let before: number;
      let wakesBefore: string[];
      let outboxBefore: Outbox;
      const again = scenario(reviewed, async (workflow) => {
        before = (await inboxOf(workflow)).length;
        wakesBefore = await wakesOf(workflow);
        outboxBefore = await outboxOf(workflow);
        ack = await workflow.handle(humanReview);
      });

      it("answers that it is a duplicate", () =>
        again(() => {
          expect(ack).toEqual({ ok: true, duplicate: true });
        }));

      it("tells the agent nothing new", () =>
        again(async (workflow) => {
          expect(await inboxOf(workflow)).toHaveLength(before);
        }));

      it("wakes the agent no second time", () =>
        again(async (workflow) => {
          expect(await wakesOf(workflow)).toEqual(wakesBefore);
        }));

      it("writes nothing back, so no channel hears about the repeat", () =>
        again(async (workflow) => {
          expect(await outboxOf(workflow)).toEqual(outboxBefore);
        }));
    });
  });

  describe("a review whose whole content is its top level body", () => {
    let ack: Ack;
    const reviewed = scenario(reviewedTask, async (workflow) => {
      ack = await workflow.handle({
        ...humanReview,
        id: "github:delivery-3",
        text: "This is a ton of unneeded complexity.",
        pull: { ...humanReviewPull, review_id: 5_121_022_926, comments: undefined },
      });
    });

    it("takes the webhook", () =>
      reviewed(() => {
        expect(ack).toEqual({ ok: true });
      }));

    it("tells the agent who reviewed, without a comment count", () =>
      reviewed(async (workflow) => {
        const note = (await inboxOf(workflow)).find((text) => text.includes("Dev reviewed"));
        expect(note).toContain(`Dev reviewed the artifact of job ${firstJobId(workflow)}.`);
      }));

    it("hands the agent the body to route", () =>
      reviewed(async (workflow) => {
        const note = (await inboxOf(workflow)).find((text) => text.includes("Dev reviewed"));
        expect(note).toContain("sent it to nobody");
        expect(note).toContain("This is a ton of unneeded complexity.");
      }));

    it("wakes the agent, since a person is waiting on the workflow", () =>
      reviewed(async (workflow) => {
        expect(await logOf(workflow)).toContain("agent wake: human");
      }));
  });
});

describe("finished workflows", () => {
  const failed = scenario(freshWorkflow, (workflow) => failWorkflow(workflow, "boom"));

  it("reports the failure", () =>
    failed((workflow) => {
      expect(workflow.state.status).toBe("failed");
    }));

  describe("a message from a person", () => {
    let before: number;
    const answered = scenario(failed, async (workflow) => {
      before = (await outboxOf(workflow)).length;
      await workflow.handle({
        ...start,
        id: "evt-late-prompt",
        kind: "prompt",
        text: "keep going with the tickets",
        acknowledge: { message: "9.0" },
      });
    });

    it("stays failed", () =>
      answered((workflow) => {
        expect(workflow.state.status).toBe("failed");
      }));

    it("answers that the workflow is failed", () =>
      answered(async (workflow) => {
        const posted = (await outboxOf(workflow)).slice(before);
        expect(posted.map((entry) => entry.payload.text)).toContain(
          "This workflow is failed. Start a new request for more work.",
        );
      }));

    it("tells the agent nothing", () =>
      answered(async (workflow) => {
        const inbox = await inboxOf(workflow);
        expect(inbox.some((text) => text.includes("keep going with the tickets"))).toBe(false);
      }));
  });

  describe("a stop from a person in a session", () => {
    let before: number;
    const stopped = scenario(failed, async (workflow) => {
      before = (await outboxOf(workflow)).length;
      await workflow.handle({
        ...start,
        id: "evt-late-stop",
        kind: "stop",
        text: "",
        reply_to: { source: "tracker", session_id: "s-1", issue_id: "ENG-1" },
        acknowledge: undefined,
      });
    });

    it("posts nothing", () =>
      stopped(async (workflow) => {
        expect(await outboxOf(workflow)).toHaveLength(before);
      }));

    it("logs that no author works in its session", () =>
      stopped(async (workflow) => {
        expect(await logOf(workflow)).toContain("stop ignored: no author works in its job session");
      }));
  });

  describe("a session the tracker opens without a person", () => {
    let before: number;
    const lateSession = scenario(failed, async (workflow) => {
      before = (await outboxOf(workflow)).length;
      await workflow.handle({
        ...start,
        id: "evt-late-session",
        kind: "start",
        text: "",
        actor: null,
        reply_to: { source: "tracker", session_id: "s-2", issue_id: "ENG-2" },
        acknowledge: undefined,
      });
    });

    it("posts nothing", () =>
      lateSession(async (workflow) => {
        expect(await outboxOf(workflow)).toHaveLength(before);
      }));

    it("logs that it ignored the session", () =>
      lateSession(async (workflow) => {
        expect(await logOf(workflow)).toContain("ignored start: the workflow is failed");
      }));
  });

  describe("a pull request event from GitHub", () => {
    let before: number;
    const ignored = scenario(failed, async (workflow) => {
      before = (await outboxOf(workflow)).length;
      await workflow.handle(prClosed);
    });

    it("posts nothing", () =>
      ignored(async (workflow) => {
        expect(await outboxOf(workflow)).toHaveLength(before);
      }));

    it("logs that it ignored the event", () =>
      ignored(async (workflow) => {
        expect(await logOf(workflow)).toContain("ignored pr_event: the workflow is failed");
      }));

    describe("then a review and a cancel, which people caused without writing to the workflow", () => {
      const stillIgnored = scenario(ignored, async (workflow) => {
        await workflow.handle(humanReview);
        await workflow.handle({
          ...start,
          id: "evt-late-cancel",
          kind: "control",
          control: "cancel",
          text: "Issue moved to Canceled",
          reply_to: undefined,
          acknowledge: undefined,
        });
      });

      it("stays failed", () =>
        stillIgnored((workflow) => {
          expect(workflow.state.status).toBe("failed");
        }));

      it("posts nothing", () =>
        stillIgnored(async (workflow) => {
          expect(await outboxOf(workflow)).toHaveLength(before);
        }));

      it("logs that it ignored the feedback", () =>
        stillIgnored(async (workflow) => {
          expect(await logOf(workflow)).toContain("ignored feedback: the workflow is failed");
        }));

      it("logs that it ignored the control word", () =>
        stillIgnored(async (workflow) => {
          expect(await logOf(workflow)).toContain("ignored control: the workflow is failed");
        }));

      describe("then a status question", () => {
        const asked = scenario(stillIgnored, async (workflow) => {
          await workflow.handle({
            ...start,
            id: "evt-late-status",
            kind: "status",
            text: "status?",
          });
        });

        it("answers with the status", () =>
          asked(async (workflow) => {
            const after = await outboxOf(workflow);
            expect(after.slice(before).map((entry) => entry.kind)).toEqual(["status"]);
          }));

        it("stays failed, so a question reopens nothing", () =>
          asked((workflow) => {
            expect(workflow.state.status).toBe("failed");
          }));
      });
    });
  });

  describe("a status question after the workflow finished", () => {
    let recorder: RecordingNotifier;
    const asked = scenario(freshWorkflow, async (workflow) => {
      recorder = new RecordingNotifier(NO_CHANNELS, () => {});
      workflow.notifier = recorder;
      await workflow.post({ type: "info", text: "working" });
      await failWorkflow(workflow, "boom");
      await workflow.handle({ ...start, id: "evt-late-status", kind: "status", text: "status?" });
    });

    it("closes the Slack session once, and keeps it open for the answer", () =>
      asked(() => {
        expect(recorder.options.map((option) => option.finished)).toEqual([false, true, true]);
        expect(recorder.options.at(-1)?.keepSession).toBe(true);
      }));
  });
});

describe("the thread title between turns", () => {
  let recorder: RecordingNotifier;
  const settled = scenario(freshWorkflow, async (workflow) => {
    recorder = new RecordingNotifier(NO_CHANNELS, () => {});
    workflow.notifier = recorder;
    workflow.patchState({ name: "Flaky checkout test" });
    await workflow.release();
    await workflow.post({ type: "info", text: "Opened the pull request." });
  });

  it("leaves a silent turn on the workflow name", () =>
    settled(() => {
      expect(recorder.releases).toEqual([{ finished: false, title: "Flaky checkout test" }]);
    }));

  it("leaves a turn that replied on the workflow name", () =>
    settled(() => {
      expect(recorder.options.map((option) => option.title)).toEqual(["Flaky checkout test"]);
    }));

  describe("a workflow before its first plan", () => {
    const unplanned = scenario(freshWorkflow, async (workflow) => {
      recorder = new RecordingNotifier(NO_CHANNELS, () => {});
      workflow.notifier = recorder;
      await workflow.release();
    });

    it("leaves the thread on the first line the person typed", () =>
      unplanned(() => {
        expect(recorder.releases).toEqual([{ finished: false, title: "fix the flaky test" }]);
      }));
  });
});

describe("idle", () => {
  it("arms the idle alarm on creation", () =>
    freshWorkflow((workflow) => {
      expect(workflow.state.idle_alarm).toBeTruthy();
    }));

  describe("a message from a person", () => {
    let first: string | null;
    const messaged = scenario(freshWorkflow, async (workflow) => {
      first = workflow.state.idle_alarm;
      await workflow.handle({ ...start, id: "evt-idle-prompt", kind: "prompt", text: "hi" });
    });

    it("starts the idle alarm over", () =>
      messaged((workflow) => {
        expect(workflow.state.idle_alarm).toBeTruthy();
        expect(workflow.state.idle_alarm).not.toBe(first);
      }));

    it("leaves one idle alarm armed", () =>
      messaged((workflow) => {
        const armed = workflow.getSchedules().filter((schedule) => schedule.callback === "onIdle");
        expect(armed).toHaveLength(1);
      }));
  });

  describe("the idle alarm firing before the first plan", () => {
    let posted: Outbox;
    const unplanned = scenario(freshWorkflow, async (workflow) => {
      const before = (await outboxOf(workflow)).length;
      await workflow.onIdle();
      posted = (await outboxOf(workflow)).slice(before);
    });

    it("stays in planning", () =>
      unplanned((workflow) => {
        expect(workflow.state.status).toBe("planning");
      }));

    it("posts nothing", () =>
      unplanned(() => {
        expect(posted).toEqual([]);
      }));
  });

  describe("the idle alarm firing with nothing at work", () => {
    let posted: Outbox;
    const slept = scenario(freshWorkflow, async (workflow) => {
      workflow.patchState({ status: "running" });
      const before = (await outboxOf(workflow)).length;
      await workflow.onIdle();
      posted = (await outboxOf(workflow)).slice(before);
    });

    it("goes to sleep", () =>
      slept((workflow) => {
        expect(workflow.state.status).toBe("waiting_input");
      }));

    it("posts one message", () =>
      slept(() => {
        expect(posted.map((entry) => entry.kind)).toEqual(["info"]);
      }));

    it("says it is going to sleep", () =>
      slept(() => {
        expect(posted[0]?.payload.text).toContain("going to sleep");
      }));

    describe("and then a message from a person", () => {
      const woken = scenario(slept, async (workflow) => {
        await workflow.handle({ ...start, id: "evt-wake", kind: "prompt", text: "continue" });
      });

      it("wakes the workflow up", () =>
        woken((workflow) => {
          expect(workflow.state.status).toBe("running");
        }));
    });
  });
});

describe("a workflow that follows an ended one", () => {
  const followed = createdFrom(start, "wf_ended");

  it("tells its first turn to read the thread of the ended workflow", () =>
    followed(async (workflow) => {
      const debug = (await workflow.debug()) as { transcript: Array<{ message: unknown }> };
      const first = JSON.stringify(debug.transcript[0]?.message);
      expect(first).toContain("workflow wf_ended ended here");
      expect(first).toContain("read_channel and thread_ts=1.0");
    }));
});

describe("a workflow that follows nothing", () => {
  it("does not mention an earlier workflow", () =>
    freshWorkflow(async (workflow) => {
      const debug = (await workflow.debug()) as { transcript: Array<{ message: unknown }> };
      expect(JSON.stringify(debug.transcript[0]?.message)).not.toContain("ended here");
    }));
});
