import {
  jsonRpcErrorResponse,
  METHOD_NOT_FOUND,
  jsonRpcRequest,
  jsonRpcResponse,
} from "@artfct-ai/acp/jsonrpc";
import { ClientMethods } from "@artfct-ai/acp/methods";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../../test/fresh-runtime";
import { onBridgeMessage } from "./bridge";
import {
  type FakeRuntime,
  type FakeSocket,
  fakeConnection,
  seedTask,
  sentMethods,
} from "../../../../test/fake-runtime";
import { type Scenario, scenario } from "../../../../test/scenario";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const REVIEW = "wf_x.2";

type Reply = {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

function replies(sent: string[]): Reply[] {
  return sent.map((frame) => JSON.parse(frame) as Reply);
}

function sessionOf(taskId: string): Scenario<{ workflow: FakeRuntime; socket: FakeSocket }> {
  return (run) => freshRuntime((workflow) => run({ workflow, socket: fakeConnection(taskId, 1) }));
}

function recordPullRequest(workflow: FakeRuntime): void {
  workflow.store.upsertArtifact({
    job_id: JOB,
    kind: "pull",
    external_url: "https://github.com/acme/app/pull/1",
    ref: { kind: "pull", repo: "acme/app", number: 1 },
  });
}

function seedReviewInFlight(workflow: FakeRuntime, socket: FakeSocket): void {
  seedTask(
    workflow,
    { task_id: REVIEW, role: "reviewer", job_id: JOB },
    { session_id: "s2", prompt_in_flight: 1 },
  );
  workflow.store.setArtifactRefinerRun(JOB, REVIEW);
  workflow.sockets.push(socket.connection);
}

describe("onBridgeMessage", () => {
  describe("a request from the agent", () => {
    describe("a permission request with a reject and an allow option", () => {
      const answered = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
        seedTask(workflow, {}, { session_id: "s1" });
        await onBridgeMessage(
          workflow,
          socket.connection,
          JSON.stringify(
            jsonRpcRequest(7, ClientMethods.sessionRequestPermission, {
              sessionId: "s1",
              toolCall: { toolCallId: "c1", title: "Run tests" },
              options: [
                { optionId: "reject", name: "Reject", kind: "reject_once" },
                { optionId: "allow", name: "Allow", kind: "allow_once" },
              ],
            }),
          ),
        );
      });

      it("selects the most permissive option", () =>
        answered(({ socket }) => {
          expect(replies(socket.sent)).toEqual([
            {
              jsonrpc: "2.0",
              id: 7,
              result: { outcome: { outcome: "selected", optionId: "allow" } },
            },
          ]);
        }));

      it("logs the tool call and the choice", () =>
        answered(({ workflow }) => {
          expect(workflow.lines).toContain("permission: Run tests -> allow");
        }));
    });

    describe("a method the client does not have", () => {
      const answered = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
        seedTask(workflow, {}, { session_id: "s1" });
        await onBridgeMessage(
          workflow,
          socket.connection,
          JSON.stringify(jsonRpcRequest(8, "fs/read_text_file", { path: "/etc/passwd" })),
        );
      });

      it("answers the request by its id", () =>
        answered(({ socket }) => {
          expect(replies(socket.sent)[0]?.id).toBe(8);
        }));

      it("answers method not found and no result", () =>
        answered(({ socket }) => {
          const [reply] = replies(socket.sent);
          expect(reply?.error?.code).toBe(METHOD_NOT_FOUND);
          expect(reply?.result).toBeUndefined();
        }));
    });
  });

  describe("an error response to an rpc", () => {
    describe("to the handshake of a task with restarts left", () => {
      const restarted = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { task_id: TASK });
        const request = workflow.store.insertRpc(TASK, "initialize", "initialize");
        await onBridgeMessage(
          workflow,
          fakeConnection(TASK, 1).connection,
          JSON.stringify(jsonRpcErrorResponse(request, -32000, "bad init")),
        );
      });

      it("restarts the task in a fresh sandbox", () =>
        restarted((workflow) => {
          expect(workflow.sandboxProvider.calls).toEqual([`destroy ${TASK}`, `start ${TASK}`]);
          expect(workflow.store.requireSandbox(TASK).restarts).toBe(1);
        }));
    });

    describe("to the handshake of two tasks with no restarts left", () => {
      const bothFailed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { task_id: TASK }, { wall_schedule: "w1", restarts: 2 });
        seedTask(workflow, { task_id: REVIEW }, { wall_schedule: "w2", restarts: 2 });
        const first = workflow.store.insertRpc(TASK, "initialize", "initialize");
        const second = workflow.store.insertRpc(REVIEW, "session/new", "session_new");
        await onBridgeMessage(
          workflow,
          fakeConnection(TASK, 1).connection,
          JSON.stringify(jsonRpcErrorResponse(first, -32000, "bad init")),
        );
        await onBridgeMessage(
          workflow,
          fakeConnection(REVIEW, 1).connection,
          JSON.stringify(jsonRpcErrorResponse(second, -32000, "no session")),
        );
      });

      it("fails both tasks", () =>
        bothFailed((workflow) => {
          expect(workflow.store.tasks().map((task) => task.status)).toEqual(["failed", "failed"]);
        }));

      it("posts a failure for each task", () =>
        bothFailed((workflow) => {
          expect(workflow.posted.map((event) => event.type)).toEqual(["failed", "failed"]);
        }));

      it("names the method that failed and the task whose log holds the details", () =>
        bothFailed((workflow) => {
          const reasons = workflow.posted.map((event) => ("reason" in event ? event.reason : ""));
          expect(reasons).toEqual([
            `The harness request initialize failed. The details are in the logs of task ${TASK}.`,
            `The harness request session/new failed. The details are in the logs of task ${REVIEW}.`,
          ]);
        }));

      it("keeps the error text of the harness out of every post", () =>
        bothFailed((workflow) => {
          expect(JSON.stringify(workflow.posted)).not.toMatch(/bad init|no session/);
        }));

      it("logs the error text of the harness", () =>
        bothFailed((workflow) => {
          expect(workflow.lines).toEqual(
            expect.arrayContaining([
              "initialize error -32000: bad init",
              "session/new error -32000: no session",
            ]),
          );
        }));

      it("cancels the wall clock alarm of each task", () =>
        bothFailed((workflow) => {
          expect(workflow.cancelled.toSorted()).toEqual(["w1", "w2"]);
        }));

      it("leaves no handshake pending", () =>
        bothFailed((workflow) => {
          expect(workflow.store.handshakePending(TASK)).toBe(false);
        }));
    });

    describe("to the prompt of a reviewer run", () => {
      describe("with a nudge queued behind the failed prompt", () => {
        const nudged = scenario(sessionOf(REVIEW), async ({ workflow, socket }) => {
          seedTask(workflow, { stage: "implement" });
          seedReviewInFlight(workflow, socket);
          workflow.store.enqueuePrompt(REVIEW, "Still there?");
          const id = workflow.store.insertRpc(REVIEW, "session/prompt", "prompt");
          await onBridgeMessage(
            workflow,
            socket.connection,
            JSON.stringify(jsonRpcErrorResponse(id, -32000, "transient")),
          );
        });

        it("keeps the reviewer alive", () =>
          nudged(({ workflow }) => {
            expect(workflow.store.requireTask(REVIEW).status).not.toBe("done");
          }));

        it("sends the queued nudge, which the drain reads before it empties the queue", () =>
          nudged(({ socket }) => {
            expect(sentMethods(socket)).toContain("session/prompt");
          }));
      });

      describe("with nothing queued behind the failed prompt", () => {
        const settled = scenario(sessionOf(REVIEW), async ({ workflow, socket }) => {
          seedTask(workflow, { stage: "implement", branch: "artfct/wf_x-1-fix" });
          recordPullRequest(workflow);
          seedReviewInFlight(workflow, socket);
          const id = workflow.store.insertRpc(REVIEW, "session/prompt", "prompt");
          await onBridgeMessage(
            workflow,
            socket.connection,
            JSON.stringify(jsonRpcErrorResponse(id, -32000, "harness died")),
          );
        });

        it("fails the reviewer run, since no turn end follows a failed prompt", () =>
          settled(({ workflow }) => {
            expect(workflow.store.requireTask(REVIEW).status).toBe("failed");
          }));

        it("takes the reviewer off the artifact", () =>
          settled(({ workflow }) => {
            expect(workflow.store.artifact(JOB)?.refiner_task_id).toBeNull();
          }));

        it("marks the artifact ready, so it is not held", () =>
          settled(({ workflow }) => {
            expect(workflow.store.artifact(JOB)?.status).toBe("ready");
          }));
      });
    });

    describe("to the fix prompt of an author task whose artifact is held", () => {
      const failed = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
        seedTask(
          workflow,
          { stage: "implement", branch: "artfct/wf_x-1-fix" },
          { session_id: "s1", prompt_in_flight: 1 },
        );
        recordPullRequest(workflow);
        seedTask(workflow, {
          task_id: REVIEW,
          role: "reviewer",
          job_id: JOB,
          refiner_index: 0,
          status: "done",
        });
        workflow.store.setArtifactRefinerRun(JOB, REVIEW);
        const id = workflow.store.insertRpc(TASK, "session/prompt", "prompt");
        workflow.sockets.push(socket.connection);
        await onBridgeMessage(
          workflow,
          socket.connection,
          JSON.stringify(jsonRpcErrorResponse(id, -32000, "harness died")),
        );
      });

      it("asks the agent where the artifact goes, as at a turn end", () =>
        failed(({ workflow }) => {
          expect(workflow.notes.some((note) => note.text.includes("is with you"))).toBe(true);
        }));
    });

    describe("to a prompt with another prompt queued", () => {
      const failed = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
        seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
        const id = workflow.store.insertRpc(TASK, "session/prompt", "prompt");
        workflow.store.enqueuePrompt(TASK, "next");
        workflow.sockets.push(socket.connection);
        await onBridgeMessage(
          workflow,
          socket.connection,
          JSON.stringify(jsonRpcErrorResponse(id, -32000, "boom")),
        );
      });

      it("reports the failure as progress", () =>
        failed(({ workflow }) => {
          expect(workflow.posted).toEqual([
            {
              type: "progress",
              task_id: TASK,
              text: `The prompt failed. The details are in the logs of task ${TASK}.`,
            },
          ]);
        }));

      it("sends the next queued prompt", () =>
        failed(({ socket }) => {
          expect(sentMethods(socket)).toEqual(["session/prompt"]);
        }));

      it("empties the queue", () =>
        failed(({ workflow }) => {
          expect(workflow.store.queue()).toEqual([]);
        }));

      it("keeps the task working with a prompt in flight", () =>
        failed(({ workflow }) => {
          expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "working" });
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ prompt_in_flight: 1 });
        }));
    });

    describe("to a cancel request", () => {
      const late = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
        seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
        const id = workflow.store.insertRpc(TASK, "session/cancel", "cancel");
        await onBridgeMessage(
          workflow,
          socket.connection,
          JSON.stringify(jsonRpcErrorResponse(id, -32000, "late")),
        );
      });

      it("leaves the task working with its prompt in flight", () =>
        late(({ workflow }) => {
          expect(workflow.store.requireTask(TASK)).toMatchObject({ status: "working" });
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ prompt_in_flight: 1 });
        }));

      it("posts nothing", () =>
        late(({ workflow }) => {
          expect(workflow.posted).toEqual([]);
        }));
    });
  });

  describe("a response to a request it never sent", () => {
    const dropped = scenario(sessionOf(TASK), async ({ workflow, socket }) => {
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      await onBridgeMessage(
        workflow,
        socket.connection,
        JSON.stringify(jsonRpcResponse(99, { stopReason: "end_turn" })),
      );
    });

    it("keeps the prompt in flight", () =>
      dropped(({ workflow }) => {
        expect(workflow.store.requireSandbox(TASK).prompt_in_flight).toBe(1);
      }));

    it("queues no note for the agent", () =>
      dropped(({ workflow }) => {
        expect(workflow.notes).toEqual([]);
      }));

    it("posts nothing", () =>
      dropped(({ workflow }) => {
        expect(workflow.posted).toEqual([]);
      }));
  });
});
