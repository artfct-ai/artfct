import type { PromptRequest, StopReason } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { RESEARCH_PAYLOAD_MAX_BYTES, RESEARCH_PAYLOAD_PATH } from "../sandbox/research-payload";
import { GAVE_UP_RESTART_TEXT, onRpcError, onTurnEnd } from "./turn";
import { NUDGE_TEXT } from "./timers";
import type { AuthorTurnOutcome } from "../author-turn";
import { AUTHOR_WORK } from "../gave-up";
import type { TodoSnapshot } from "../../board/types";
import type { TaskRow } from "../../store/tasks";
import {
  type FakeRuntime,
  type FakeSocket,
  fakeConnection,
  patchStagePolishers,
  REVIEW_JOB,
  seedIssuesTask,
  seedPolisherRun,
  seedPullRequestTask,
  seedTask,
  sentMethods,
} from "../../../../test/fake-runtime";
import { scenario } from "../../../../test/scenario";
import { FakeCodeHost, pullRequest } from "@artfct-ai/adapters/test/fake-code-host";
import { FakeDecisions } from "@artfct-ai/adapters/test/fake-decisions";
import { FakeGateway } from "@artfct-ai/adapters/test/fake-gateway";
import { markArtifactReady } from "../../refiner/outcome";

const TASK = "wf_x.1";
const JOB = "wf_x-1";

function hostAt(sha: string): FakeCodeHost {
  return new FakeCodeHost({
    pulls: [pullRequest({ number: 1, head: { ref: "artfct/wf_x-1-fix", sha } })],
  });
}
const REVIEW_TASK = "wf_x.2";

function decisionsPick(workflow: FakeRuntime, outcome: AuthorTurnOutcome): FakeDecisions {
  const decisions = new FakeDecisions({}, { outcome: { option: outcome, probability: 0.9 } });
  workflow.gatewayInstance = new FakeGateway({ decisions });
  return decisions;
}

function endsInOutage(seed: (workflow: FakeRuntime) => TaskRow) {
  return scenario(freshRuntime, (workflow) => {
    workflow.gatewayInstance = new FakeGateway({
      decisions: new FakeDecisions(new Error("unavailable")),
    });
    const author = seed(workflow);
    workflow.store.updateSandbox(TASK, { prompt_in_flight: 1, turn_text: "Tests run." });
    return onTurnEnd(workflow, author, "end_turn");
  });
}

function stalledAgain(restarts: number) {
  return scenario(freshRuntime, (workflow) => {
    decisionsPick(workflow, "stopped_early");
    const author = seedTask(
      workflow,
      {},
      { prompt_in_flight: 1, generation: 1, turn_text: "Tests run.", nudged: 1, restarts },
    );
    return onTurnEnd(workflow, author, "end_turn");
  });
}

function promptTextsSent(socket: FakeSocket): string[] {
  return socket.sent.flatMap((frame) => {
    const sent = JSON.parse(frame) as { method?: string; params?: PromptRequest };
    if (sent.method !== "session/prompt" || !sent.params) return [];
    return sent.params.prompt.flatMap((block) => (block.type === "text" ? [block.text] : []));
  });
}

const unfinished = (role: "reviewer" | "polisher", stopReason: StopReason, restarts = 2) =>
  scenario(freshRuntime, (workflow) => {
    seedTask(workflow);
    const run = seedTask(
      workflow,
      { task_id: REVIEW_TASK, role, job_id: JOB },
      { prompt_in_flight: 1, restarts },
    );
    return onTurnEnd(workflow, run, stopReason);
  });

function followUpEndsAt(sha: string) {
  return scenario(freshRuntime, async (workflow) => {
    workflow.codeHostInstance = hostAt("abc123");
    const task = seedPullRequestTask(workflow);
    workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
    await markArtifactReady(workflow, task.job_id, { close: "ready" });
    workflow.codeHostInstance = hostAt(sha);
    await onTurnEnd(workflow, workflow.store.requireTask(TASK), "end_turn");
  });
}

describe("onTurnEnd", () => {
  describe("a review task whose turn the queued nudge cancelled", () => {
    const nudged = scenario(freshRuntime, (workflow) => {
      seedTask(workflow);
      const review = seedTask(
        workflow,
        { task_id: REVIEW_TASK, role: "reviewer", job_id: JOB },
        { prompt_in_flight: 1 },
      );
      workflow.store.enqueuePrompt(REVIEW_TASK, "Still there?");
      return onTurnEnd(workflow, review, "cancelled");
    });

    it("does not call the cancelled turn the review", () =>
      nudged((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).not.toBe("done");
      }));

    it("keeps the sandbox, which a finished review would destroy", () =>
      nudged((workflow) => {
        expect(workflow.sandboxProvider.calls).not.toContain("destroy wf_x.2");
      }));

    it("drains the nudge instead, which wakes the sandbox when no bridge is up", () =>
      nudged((workflow) => {
        expect(workflow.lines).toContain("no bridge connection. waking sandbox.");
      }));
  });

  describe("a refiner run whose turn the harness did not finish", () => {
    it("restarts a reviewer that has restarts left", () =>
      unfinished(
        "reviewer",
        "max_tokens",
        0,
      )((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("provisioning");
        expect(workflow.store.requireSandbox(REVIEW_TASK).restarts).toBe(1);
      }));

    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"] as const) {
      it(`fails a reviewer with no restarts left on ${stopReason}`, () =>
        unfinished(
          "reviewer",
          stopReason,
        )((workflow) => {
          expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("failed");
        }));
    }

    it("fails a polisher with no restarts left", () =>
      unfinished(
        "polisher",
        "max_tokens",
      )((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("failed");
      }));

    it("logs the stop reason as the failure", () =>
      unfinished(
        "reviewer",
        "refusal",
      )((workflow) => {
        expect(workflow.lines).toContain(
          "failed: The turn ended on refusal before the work was complete.",
        );
      }));
  });

  describe("a refiner run whose turn text says it gave up", () => {
    const BLOCKED = "I could not check out the branch, so I did not review the change.";
    const gaveUp = (role: "reviewer" | "polisher", restarts = 2) =>
      scenario(freshRuntime, (workflow) => {
        workflow.gatewayInstance = new FakeGateway({
          decisions: new FakeDecisions({ gave_up: 0.9 }),
        });
        seedTask(workflow);
        const run = seedTask(
          workflow,
          { task_id: REVIEW_TASK, role, job_id: JOB },
          { prompt_in_flight: 1, turn_text: BLOCKED, restarts },
        );
        return onTurnEnd(workflow, run, "end_turn");
      });

    it("restarts a reviewer that has restarts left", () =>
      gaveUp(
        "reviewer",
        0,
      )((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([
          `destroy ${REVIEW_TASK}`,
          `start ${REVIEW_TASK}`,
        ]);
      }));

    it("fails a reviewer with no restarts left", () =>
      gaveUp("reviewer")((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("failed");
      }));

    it("fails a polisher with no restarts left", () =>
      gaveUp("polisher")((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("failed");
      }));

    it("logs the turn text as the failure", () =>
      gaveUp("reviewer")((workflow) => {
        expect(workflow.lines).toContain(`failed: The reviewer gave up: ${BLOCKED}`);
      }));
  });

  describe("an author whose turn text says it is blocked", () => {
    const BLOCKED = "I have no access to the repository, so I stopped.";
    const authorEnds = (
      outcome: AuthorTurnOutcome,
      stopReason: "end_turn" | "cancelled",
      restarts = 0,
    ) =>
      scenario(freshRuntime, (workflow) => {
        decisionsPick(workflow, outcome);
        const author = seedTask(
          workflow,
          {},
          { prompt_in_flight: 1, turn_text: BLOCKED, generation: 1, restarts },
        );
        return onTurnEnd(workflow, author, stopReason);
      });

    it("starts the author over in a fresh sandbox", () =>
      authorEnds(
        "blocked",
        "end_turn",
      )((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
      }));

    it("counts the restart on a new generation", () =>
      authorEnds(
        "blocked",
        "end_turn",
      )((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("provisioning");
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({ generation: 2, restarts: 1 });
      }));

    it("queues the wake text the fresh harness resumes with", () =>
      authorEnds(
        "blocked",
        "end_turn",
      )((workflow) => {
        expect(workflow.store.peekPrompt(TASK)?.text).toBe(GAVE_UP_RESTART_TEXT);
      }));

    it("shows the restart on the board", () =>
      authorEnds(
        "blocked",
        "end_turn",
      )((workflow) => {
        expect(workflow.store.todoRow(TASK)?.note).toBe(
          `Restarted in a fresh sandbox: The author gave up: ${BLOCKED}`,
        );
      }));

    it("tells the agent without waking it", () =>
      authorEnds(
        "blocked",
        "end_turn",
      )((workflow) => {
        expect(workflow.notes.map((note) => note.wake)).toEqual(["none"]);
        expect(workflow.noteTexts()[0]).toContain(`The author gave up: ${BLOCKED}`);
      }));

    it("fails the task when it is blocked with no restarts left", () =>
      authorEnds(
        "blocked",
        "end_turn",
        2,
      )((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
        expect(workflow.lines).toContain(`failed: The author gave up: ${BLOCKED}`);
      }));

    it("tells the agent once, as a failed task, with no restarts left", () =>
      authorEnds(
        "blocked",
        "end_turn",
        2,
      )((workflow) => {
        expect(workflow.notes.map((note) => note.wake)).toEqual(["task_result"]);
      }));

    it("leaves the task alone when the decisions model says the work is finished", () =>
      authorEnds(
        "finished",
        "end_turn",
      )((workflow) => {
        expect(workflow.store.requireTask(TASK).status).not.toBe("failed");
        expect(workflow.store.requireSandbox(TASK).restarts).toBe(0);
      }));

    it("does not ask about a cancelled turn", () =>
      authorEnds(
        "blocked",
        "cancelled",
      )((workflow) => {
        expect(workflow.store.requireTask(TASK).status).not.toBe("failed");
        expect(workflow.store.requireSandbox(TASK).restarts).toBe(0);
      }));
  });

  describe("an author turn that ends on its own", () => {
    const STOPPED =
      "The test suite runs in the background. I will report the result when it finishes.";
    let decisions: FakeDecisions;
    const asked = scenario(freshRuntime, (workflow) => {
      decisions = decisionsPick(workflow, "finished");
      const author = seedTask(workflow, {}, { prompt_in_flight: 1, turn_text: STOPPED });
      return onTurnEnd(workflow, author, "end_turn");
    });

    it("asks the decisions model one choice question over the closing text and the work", () =>
      asked((workflow) => {
        const author = workflow.store.requireTask(TASK);
        const work = AUTHOR_WORK[workflow.stageForTask(author).artifact];
        expect(decisions.asked).toEqual([{ work, turn_text: STOPPED }]);
        expect(decisions.yesNoAsked).toEqual([{}]);
        expect(Object.keys(decisions.offered[0]?.options ?? {})).toEqual([
          "finished",
          "waits_on_person",
          "blocked",
          "stopped_early",
        ]);
      }));
  });

  describe("an author that stopped early", () => {
    let socket: FakeSocket;
    const stoppedEarly = scenario(freshRuntime, (workflow) => {
      decisionsPick(workflow, "stopped_early");
      const author = seedTask(
        workflow,
        {},
        { session_id: "s1", prompt_in_flight: 1, generation: 1, turn_text: "Tests run." },
      );
      socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      return onTurnEnd(workflow, author, "end_turn");
    });

    it("gets the nudge in the same harness session", () =>
      stoppedEarly((workflow) => {
        expect(promptTextsSent(socket)).toEqual([NUDGE_TEXT]);
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          session_id: "s1",
          generation: 1,
          prompt_in_flight: 1,
        });
      }));

    it("keeps its sandbox", () =>
      stoppedEarly((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`keepAlive ${TASK}`]);
      }));

    it("is nudged", () =>
      stoppedEarly((workflow) => {
        expect(workflow.store.requireSandbox(TASK).nudged).toBe(1);
      }));

    it("wakes nobody", () =>
      stoppedEarly((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });

  describe("an author that stopped early while still nudged", () => {
    it("starts over in a fresh sandbox", () =>
      stalledAgain(0)((workflow) => {
        expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          generation: 2,
          restarts: 1,
          nudged: 0,
        });
      }));

    it("tells the agent without waking it", () =>
      stalledAgain(0)((workflow) => {
        expect(workflow.notes.map((note) => note.wake)).toEqual(["none"]);
        expect(workflow.noteTexts()[0]).toContain("No progress after a nudge.");
      }));

    it("fails the task with no restarts left", () =>
      stalledAgain(2)((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
        expect(workflow.notes.map((note) => note.wake)).toEqual(["task_result"]);
      }));
  });

  describe("an author that stopped early with a prompt queued behind its turn", () => {
    let socket: FakeSocket;
    const prompted = scenario(freshRuntime, (workflow) => {
      decisionsPick(workflow, "stopped_early");
      const author = seedTask(
        workflow,
        {},
        { session_id: "s1", prompt_in_flight: 1, turn_text: "Tests run." },
      );
      workflow.store.enqueuePrompt(TASK, "next");
      socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      return onTurnEnd(workflow, author, "end_turn");
    });

    it("gets the queued prompt and no nudge", () =>
      prompted((workflow) => {
        expect(promptTextsSent(socket)).toEqual(["next"]);
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.store.requireSandbox(TASK).nudged).toBe(0);
      }));
  });

  for (const outcome of ["finished", "waits_on_person"] as const) {
    describe(`an author whose turn is ${outcome}`, () => {
      const settled = scenario(freshRuntime, (workflow) => {
        decisionsPick(workflow, outcome);
        const author = seedTask(workflow, {}, { prompt_in_flight: 1, turn_text: "Done." });
        return onTurnEnd(workflow, author, "end_turn");
      });

      it("wakes the agent with the idle harness and queues nothing", () =>
        settled((workflow) => {
          expect(workflow.notes.map((note) => note.wake)).toEqual(["task_idle"]);
          expect(workflow.store.queue()).toEqual([]);
          expect(workflow.store.requireSandbox(TASK).nudged).toBe(0);
        }));
    });
  }

  describe("an author turn the decisions model cannot judge", () => {
    const OPEN_TODOS: TodoSnapshot = {
      entries: [
        { content: "Change the redirect", priority: "medium", status: "completed" },
        { content: "Run the tests", priority: "medium", status: "pending" },
      ],
    };

    it("takes it as stopped early with open todos and no artifact", () =>
      endsInOutage((workflow) => {
        const author = seedTask(workflow);
        workflow.store.setTodos(TASK, OPEN_TODOS);
        return author;
      })((workflow) => {
        expect(workflow.store.peekPrompt(TASK)?.text).toBe(NUDGE_TEXT);
      }));

    it("takes it as finished with open todos and an artifact", () =>
      endsInOutage((workflow) => {
        const author = seedPullRequestTask(workflow);
        workflow.store.setTodos(TASK, OPEN_TODOS);
        return author;
      })((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.store.requireSandbox(TASK).nudged).toBe(0);
      }));

    it("takes it as finished without a todo list", () =>
      endsInOutage((workflow) => seedTask(workflow))((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
        expect(workflow.notes.map((note) => note.wake)).toEqual(["task_idle"]);
      }));
  });

  describe("an author turn that ends with an artifact and nothing left to run", () => {
    const idle = scenario(freshRuntime, (workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("puts the row back to in review, so no reader repeats working", () =>
      idle((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("in_review");
      }));
  });

  describe("an author turn that ends on a reopened artifact, in a stage with no reviewers", () => {
    const reopened = scenario(freshRuntime, (workflow) => {
      const stages = workflow
        .workflowDefinition()
        .stages.map((stage) => ({ ...stage, reviewers: [] }));
      workflow.patchWorkflowDefinition({ stages });
      const task = seedIssuesTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("gives the artifact back to the humans", () =>
      reopened((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("announces it with its link", () =>
      reopened((workflow) => {
        expect(workflow.posted).toContainEqual(
          expect.objectContaining({
            type: "artifact_ready",
            url: "https://linear.app/acme/issue/ENG-42",
          }),
        );
      }));
  });

  describe("a follow-up turn on a pull request the humans have", () => {
    describe("when the turn pushed nothing", () => {
      const unchanged = followUpEndsAt("abc123");

      it("leaves the artifact with the humans", () =>
        unchanged((workflow) => {
          expect(workflow.store.artifact(JOB)?.status).toBe("ready");
        }));

      it("starts no refiner", () =>
        unchanged((workflow) => {
          expect(workflow.store.refinerRunsOf(JOB)).toEqual([]);
        }));

      it("wakes the agent for an idle task", () =>
        unchanged((workflow) => {
          expect(workflow.notes.at(-1)?.wake).toBe("task_idle");
        }));
    });

    describe("when the turn pushed a new revision", () => {
      const changed = followUpEndsAt("def456");

      it("holds the artifact as a draft again", () =>
        changed((workflow) => {
          expect(workflow.store.artifact(JOB)?.status).toBe("drafted");
        }));

      it("runs the refiner list from the top", () =>
        changed((workflow) => {
          expect(workflow.store.refinerRunsOf(JOB).map((run) => run.refiner_index)).toEqual([0]);
        }));
    });
  });

  describe("an author a human paused, whose turn ends with an artifact", () => {
    const paused = scenario(freshRuntime, (workflow) => {
      const task = seedPullRequestTask(workflow, { paused_at: "2026-09-03T10:00:00.000Z" });
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("keeps the hold", () =>
      paused((workflow) => {
        expect(workflow.store.requireTask(TASK).paused_at).not.toBeNull();
      }));
  });

  describe("an author turn that ends with no artifact", () => {
    const working = scenario(freshRuntime, (workflow) =>
      onTurnEnd(workflow, seedTask(workflow, {}, { prompt_in_flight: 1 }), "end_turn"),
    );

    it("leaves the row working", () =>
      working((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("working");
      }));
  });

  describe("a turn that ended with text, a tool call and a failed tool", () => {
    const text = "Working on it.\nAll done.";
    const ended = scenario(freshRuntime, (workflow) => {
      workflow.patchState({ name: "Flaky checkout test" });
      const task = seedTask(workflow, { cost_usd: 0.7 }, { turn_text: text, prompt_in_flight: 1 });
      workflow.store.countToolCall(TASK);
      workflow.store.countToolFailure(TASK, "bash");
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("keeps the text as the summary and ends the prompt", () =>
      ended((workflow) => {
        expect(workflow.store.requireTask(TASK)).toMatchObject({ summary: text });
        expect(workflow.store.requireSandbox(TASK)).toMatchObject({
          prompt_in_flight: 0,
          turn_text: "",
        });
      }));

    it("logs the stop reason", () =>
      ended((workflow) => {
        expect(workflow.lines).toContain("turn ended: end_turn");
      }));

    it("posts nothing", () =>
      ended((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("queues one note for the agent", () =>
      ended((workflow) => {
        expect(workflow.notes).toHaveLength(1);
      }));

    it("wakes the agent for an idle task", () =>
      ended((workflow) => {
        expect(workflow.notes[0]?.wake).toBe("task_idle");
      }));

    it("resets the tool counters", () =>
      ended((workflow) => {
        expect(workflow.store.todoRow(TASK)).toMatchObject({ tool_calls: 0, tool_failures: 0 });
      }));

    describe("the digest the note carries", () => {
      let note: string;
      const digest = scenario(ended, (workflow) => {
        note = workflow.notes[0]?.text ?? "";
      });

      it("names the stop reason", () =>
        digest(() => {
          expect(note).toContain("Harness turn ended (end_turn).");
        }));

      it("names the task, the workflow, its stage and its status", () =>
        digest(() => {
          expect(note).toContain(`[task ${TASK} · Flaky checkout test · design · working]`);
        }));

      it("reports no result yet", () =>
        digest(() => {
          expect(note).toContain("result: none yet");
        }));

      it("reports the tool calls and the tool that failed", () =>
        digest(() => {
          expect(note).toContain("tools: 1 since the last turn, 1 failed (bash)");
        }));

      it("quotes the turn text on one line", () =>
        digest(() => {
          expect(note).toContain('last: "Working on it. All done."');
        }));

      it("leaves out the old output block", () =>
        digest(() => {
          expect(note).not.toContain("Last output:");
        }));
    });
  });

  describe("a turn with another prompt queued behind it", () => {
    let socket: FakeSocket;
    const ended = scenario(freshRuntime, (workflow) => {
      const task = seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      workflow.store.enqueuePrompt(TASK, "next");
      socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("sends the queued prompt", () =>
      ended(() => {
        expect(sentMethods(socket)).toEqual(["session/prompt"]);
      }));

    it("empties the queue", () =>
      ended((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));

    it("leaves the new prompt in flight", () =>
      ended((workflow) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));

    it("wakes nobody", () =>
      ended((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });

  describe("a turn on a task with a Slack thread to report to", () => {
    const inThread = scenario(freshRuntime, (workflow) => {
      workflow.state.reply_targets = [{ source: "chat", channel: "C1", thread: "1.1" }];
    });

    describe("once the harness has reported todos", () => {
      const ended = scenario(inThread, (workflow) => {
        const task = seedTask(workflow, {}, { turn_text: "still going" });
        workflow.store.setTodos(TASK, {
          entries: [{ content: "step one", priority: "medium", status: "pending" }],
        });
        return onTurnEnd(workflow, task, "end_turn");
      });

      it("flushes the board to the thread", () =>
        ended((workflow) => {
          expect(workflow.store.boards(JOB)).toMatchObject([
            { channel_key: "chat:C1:1.1", message_id: "local:chat" },
          ]);
        }));

      it("writes one board entry to the outbox", () =>
        ended((workflow) => {
          expect(workflow.store.outbox().map((entry) => [entry.channel, entry.kind])).toEqual([
            ["board", "create"],
          ]);
        }));
    });

    describe("before the harness reports any todos", () => {
      const ended = scenario(inThread, (workflow) =>
        onTurnEnd(workflow, seedTask(workflow, {}, { turn_text: "still going" }), "end_turn"),
      );

      it("posts the board to the thread anyway", () =>
        ended((workflow) => {
          expect(workflow.store.boards(JOB)).toMatchObject([{ channel_key: "chat:C1:1.1" }]);
        }));

      it("writes one board entry to the outbox", () =>
        ended((workflow) => {
          const boards = workflow.store.outbox().filter((entry) => entry.channel === "board");
          expect(boards.map((entry) => entry.kind)).toEqual(["create"]);
        }));

      it("says no todo list came in yet", () =>
        ended((workflow) => {
          const boards = workflow.store.outbox().filter((entry) => entry.channel === "board");
          expect(JSON.stringify(boards[0]?.payload)).toContain("no todo list reported");
        }));
    });
  });

  describe("a turn that opened an artifact the review holds", () => {
    const ended = scenario(freshRuntime, (workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { turn_text: "opened the pull request" });
      return onTurnEnd(workflow, task, "end_turn");
    });

    it("wakes nobody", () =>
      ended((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));

    it("starts the first reviewer", () =>
      ended((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));
  });

  describe("a polisher turn that named the pull request it worked on", () => {
    const ended = scenario(freshRuntime, async (workflow) => {
      patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
      const polisher = seedPolisherRun(workflow);
      workflow.store.updateTask(polisher.task_id, { status: "working" });
      workflow.store.updateSandbox(polisher.task_id, {
        turn_text: `Rewrote the comments on https://github.com/acme/app/pull/1`,
      });
      await onTurnEnd(workflow, workflow.store.requireTask(polisher.task_id), "end_turn");
    });

    it("gives the artifact to the humans", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(REVIEW_JOB)?.status).toBe("ready");
      }));

    it("records no artifact of its own for the pull request it named", () =>
      ended((workflow) => {
        expect(workflow.store.artifact(REVIEW_TASK)).toBeNull();
      }));

    it("wakes nobody, because a polisher routes nothing", () =>
      ended((workflow) => {
        expect(workflow.notes).toEqual([]);
      }));
  });

  describe("a polisher turn the queued nudge cancelled", () => {
    const nudged = scenario(freshRuntime, async (workflow) => {
      patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
      const polisher = seedPolisherRun(workflow);
      workflow.store.updateTask(polisher.task_id, { status: "working" });
      workflow.store.updateSandbox(polisher.task_id, { prompt_in_flight: 1 });
      workflow.store.enqueuePrompt(polisher.task_id, "Still there?");
      await onTurnEnd(workflow, workflow.store.requireTask(polisher.task_id), "cancelled");
    });

    it("does not call the cancelled turn the end of the polish", () =>
      nudged((workflow) => {
        expect(workflow.store.requireTask(REVIEW_TASK).status).not.toBe("done");
      }));

    it("keeps the artifact with the polisher", () =>
      nudged((workflow) => {
        expect(workflow.store.artifact(REVIEW_JOB)).toMatchObject({
          status: "drafted",
          refiner_task_id: REVIEW_TASK,
        });
      }));

    it("keeps the container, so work it never pushed survives", () =>
      nudged((workflow) => {
        expect(workflow.sandboxProvider.calls).not.toContain(`destroy ${REVIEW_TASK}`);
      }));
  });
});

function brokenPolisher(queued: string | null, restarts = 2) {
  return scenario(freshRuntime, async (workflow) => {
    patchStagePolishers(workflow, [{ name: "comments", skill: "technical-writer" }]);
    const polisher = seedPolisherRun(workflow);
    workflow.store.updateTask(polisher.task_id, { status: "working" });
    workflow.store.updateSandbox(polisher.task_id, { prompt_in_flight: 1, restarts });
    if (queued) workflow.store.enqueuePrompt(polisher.task_id, queued);
    await onRpcError(
      workflow,
      workflow.store.requireTask(polisher.task_id),
      "prompt",
      "session/prompt",
      { code: -32603, message: "harness refused" },
    );
  });
}

describe("onRpcError", () => {
  describe("an author prompt the harness refused, with an artifact under review", () => {
    const refused = scenario(freshRuntime, (workflow) => {
      const task = seedPullRequestTask(workflow);
      workflow.store.updateSandbox(TASK, { prompt_in_flight: 1 });
      return onRpcError(workflow, task, "prompt", "session/prompt", {
        code: -32603,
        message: "harness refused",
      });
    });

    it("puts the row back to in review, the way a turn end would", () =>
      refused((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("in_review");
      }));

    it("keeps a note that names the failed prompt and the task whose log holds the details", () =>
      refused((workflow) => {
        expect(workflow.store.todoRow(TASK)?.note).toBe(
          `The prompt failed. The details are in the logs of task ${TASK}.`,
        );
      }));

    it("logs the error text of the harness", () =>
      refused((workflow) => {
        expect(workflow.lines).toContain("session/prompt error -32603: harness refused");
      }));

    it("keeps the error text of the harness from the orchestrator agent", () =>
      refused((workflow) => {
        expect(workflow.noteTexts().join("\n")).not.toContain("harness refused");
      }));

    it("settles the review, so the artifact is not left held", () =>
      refused((workflow) => {
        expect(workflow.store.activeRefinerRuns()).toHaveLength(1);
      }));
  });

  describe("a polisher prompt the harness refused", () => {
    describe("with the nudge queued behind it", () => {
      const withNudge = brokenPolisher("Still there?");

      it("sends what is queued instead of ending the polish", () =>
        withNudge((workflow) => {
          expect(workflow.store.requireTask(REVIEW_TASK).status).not.toBe("done");
          expect(workflow.store.artifact(REVIEW_JOB)?.status).toBe("drafted");
        }));
    });

    describe("with nothing queued behind it and restarts left", () => {
      const restarted = brokenPolisher(null, 0);

      it("restarts the polisher run and keeps the artifact in review", () =>
        restarted((workflow) => {
          expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("provisioning");
          expect(workflow.store.artifact(REVIEW_JOB)?.status).toBe("drafted");
        }));
    });

    describe("with nothing queued behind it and no restarts left", () => {
      const alone = brokenPolisher(null);

      it("ends the polish and gives the artifact to the humans with the reason", () =>
        alone((workflow) => {
          expect(workflow.store.artifact(REVIEW_JOB)?.status).toBe("ready");
          const announced = workflow.posted.find((event) => event.type === "artifact_ready");
          expect(announced?.type === "artifact_ready" ? announced.text : "").toContain(
            `The polish stopped early (The prompt failed. The details are in the logs of task ${REVIEW_TASK}.). The branch may hold part of its changes.`,
          );
        }));

      it("keeps the error text of the harness out of every post", () =>
        alone((workflow) => {
          expect(JSON.stringify(workflow.posted)).not.toContain("harness refused");
        }));

      it("fails the polisher run", () =>
        alone((workflow) => {
          expect(workflow.store.requireTask(REVIEW_TASK).status).toBe("failed");
        }));
    });
  });
});

const researchEnds = (payload: string | null, stopReason: StopReason = "end_turn") =>
  scenario(freshRuntime, (workflow) => {
    const researcher = seedTask(
      workflow,
      { role: "researcher", stage: "implement" },
      { prompt_in_flight: 1, restarts: 2 },
    );
    if (payload !== null) workflow.sandboxProvider.putFile(TASK, RESEARCH_PAYLOAD_PATH, payload);
    return onTurnEnd(workflow, researcher, stopReason);
  });

const authorsOf = (workflow: FakeRuntime) =>
  workflow.store.tasks().filter((task) => task.job_id === JOB && task.role === "author");

describe("onTurnEnd for a researcher", () => {
  describe("a researcher that wrote its payload", () => {
    const payload = '{"summary":"the redirect lives in src/login.ts:12"}';
    const researched = researchEnds(payload);

    it("stores the payload on the job", () =>
      researched((workflow) => {
        expect(workflow.store.requireJob(JOB).research_payload).toBe(payload);
      }));

    it("is done", () =>
      researched((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("done");
      }));

    it("destroys its sandbox", () =>
      researched((workflow) => {
        expect(workflow.sandboxProvider.calls).toContain(`destroy ${TASK}`);
      }));

    it("starts the author of the job on the produce harness and model", () =>
      researched((workflow) => {
        const { produce } = workflow.stageFor(workflow.store.requireJob(JOB)).author;
        const [author, ...others] = authorsOf(workflow);
        expect(others).toEqual([]);
        expect(author).toMatchObject({ status: "queued", model: produce.model });
        expect(workflow.store.requireSandbox(author!.task_id).harness).toBe(produce.harness);
      }));

    it("provisions the author", () =>
      researched((workflow) => {
        const [author] = authorsOf(workflow);
        expect(workflow.alarmsFor("provision").map((alarm) => alarm.payload)).toContainEqual({
          task_id: author?.task_id,
        });
      }));
  });

  describe("a researcher that wrote no payload", () => {
    const missing = researchEnds(null);

    it("fails", () =>
      missing((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("starts no author", () =>
      missing((workflow) => {
        expect(authorsOf(workflow)).toEqual([]);
      }));

    it("stores no payload", () =>
      missing((workflow) => {
        expect(workflow.store.requireJob(JOB).research_payload).toBeNull();
      }));

    it("posts that the read failed and the task whose log holds the details", () =>
      missing((workflow) => {
        expect(workflow.posted).toContainEqual({
          type: "failed",
          job_id: JOB,
          reason: `The read of the research payload at ${RESEARCH_PAYLOAD_PATH} failed. The details are in the logs of task ${TASK}.`,
        });
      }));

    it("keeps the error text of the sandbox out of every post", () =>
      missing((workflow) => {
        expect(JSON.stringify(workflow.posted)).not.toContain("no file at");
      }));

    it("logs the error text of the sandbox", () =>
      missing((workflow) => {
        expect(workflow.lines).toContain(
          `research payload read failed: Error: no file at ${RESEARCH_PAYLOAD_PATH} in sandbox ${TASK}`,
        );
      }));
  });

  describe("a researcher whose payload is over the limit", () => {
    const oversized = researchEnds("x".repeat(RESEARCH_PAYLOAD_MAX_BYTES + 1));

    it("posts the size and the limit unchanged", () =>
      oversized((workflow) => {
        expect(workflow.posted).toContainEqual({
          type: "failed",
          job_id: JOB,
          reason: `The research payload is ${RESEARCH_PAYLOAD_MAX_BYTES + 1} bytes, over the limit of ${RESEARCH_PAYLOAD_MAX_BYTES}.`,
        });
      }));

    it("fails", () =>
      oversized((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
      }));

    it("starts no author", () =>
      oversized((workflow) => {
        expect(authorsOf(workflow)).toEqual([]);
      }));
  });

  describe("a researcher whose turn the harness did not finish", () => {
    const cutShort = researchEnds("{}", "max_tokens");

    it("fails without storing the payload", () =>
      cutShort((workflow) => {
        expect(workflow.store.requireTask(TASK).status).toBe("failed");
        expect(workflow.store.requireJob(JOB).research_payload).toBeNull();
      }));
  });
});
