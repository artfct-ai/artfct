import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { applyControlWord } from "./controls";
import { type FakeSocket, fakeConnection, seedTask, sentMethods } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";

const TASK = "wf_x.1";
const PAUSED_AT = "2026-09-03T10:00:00.000Z";
const actor = { person_id: "p1", email: "dev@acme.test", display_name: "Dev" };

function controlEvent(
  word: NonNullable<InboundEvent["control"]>,
  text = "",
  patch: Partial<InboundEvent> = {},
): InboundEvent {
  return {
    id: `evt-${word}`,
    kind: "control",
    actor,
    bindings: [],
    links: [],
    text,
    control: word,
    reply_to: { source: "chat", channel: "C1", thread: "1.0" },
    ...patch,
  };
}

type PromptFrame = { method?: string; params?: { prompt?: Array<{ text: string }> } };

function promptTexts(socket: FakeSocket): string[] {
  return socket.sent
    .map((frame) => JSON.parse(frame) as PromptFrame)
    .filter((message) => message.method === "session/prompt")
    .map((message) => message.params?.prompt?.[0]?.text ?? "");
}

describe("control", () => {
  describe("pause", () => {
    describe("a job whose researcher still works", () => {
      const paused = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { role: "researcher" });
        await applyControlWord(workflow, controlEvent("pause"));
      });

      it("holds the researcher", () =>
        paused((workflow) => {
          expect(workflow.store.requireTask(TASK).paused_at).not.toBeNull();
        }));
    });

    describe("a task with a turn in flight", () => {
      let socket: FakeSocket;
      const paused = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
        socket = fakeConnection(TASK, 1);
        workflow.sockets.push(socket.connection);
        await applyControlWord(workflow, controlEvent("pause"));
      });

      it("stops the current turn", () =>
        paused(() => {
          expect(sentMethods(socket)).toEqual(["session/cancel"]);
        }));

      it("holds the task and keeps its status", () =>
        paused((workflow) => {
          const task = workflow.store.requireTask(TASK);
          expect(task.status).toBe("working");
          expect(task.paused_at).not.toBeNull();
        }));

      it("says how to continue", () =>
        paused((workflow) => {
          expect(workflow.posted).toEqual([
            { type: "info", text: `Paused ${TASK}. Reply "resume" to continue.` },
          ]);
        }));

      describe("and an instruction arrives while it is paused", () => {
        const instructed = scenario(paused, async (workflow) => {
          await applyControlWord(workflow, controlEvent("instruct", "also add docs"));
        });

        it("holds the text for later", () =>
          instructed((workflow) => {
            expect(workflow.store.queue().map((row) => row.text)).toEqual(["also add docs"]);
          }));

        it("sends the task nothing", () =>
          instructed(() => {
            expect(sentMethods(socket)).toEqual(["session/cancel"]);
          }));

        describe("and a second pause arrives", () => {
          const pausedAgain = scenario(instructed, async (workflow) => {
            await applyControlWord(workflow, controlEvent("pause"));
          });

          it("says nothing a second time", () =>
            pausedAgain((workflow) => {
              expect(workflow.posted).toHaveLength(1);
            }));
        });
      });
    });
  });

  describe("resume", () => {
    describe("a paused task with a held prompt", () => {
      let socket: FakeSocket;
      const resumed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { paused_at: PAUSED_AT }, { session_id: "s1", prompt_in_flight: 1 });
        workflow.store.enqueuePrompt(TASK, "held");
        socket = fakeConnection(TASK, 1);
        workflow.sockets.push(socket.connection);
        await applyControlWord(workflow, controlEvent("resume"));
      });

      it("says the task is resumed", () =>
        resumed((workflow) => {
          expect(workflow.posted).toEqual([{ type: "info", text: `Resumed ${TASK}.` }]);
        }));

      it("sends the held prompt first", () =>
        resumed(() => {
          expect(promptTexts(socket)).toEqual(["held"]);
        }));

      it("queues the nudge to carry on behind it", () =>
        resumed((workflow) => {
          expect(workflow.store.queue().map((row) => row.text)).toEqual([
            "Continue where you left off.",
          ]);
        }));

      it("releases the hold and keeps the status", () =>
        resumed((workflow) => {
          expect(workflow.store.requireTask(TASK)).toMatchObject({
            status: "working",
            paused_at: null,
          });
          expect(workflow.store.requireSandbox(TASK)).toMatchObject({ prompt_in_flight: 1 });
        }));
    });

    describe("a paused task resumed with reply text", () => {
      let socket: FakeSocket;
      const resumed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { status: "in_review", paused_at: PAUSED_AT }, { session_id: "s1" });
        socket = fakeConnection(TASK, 1);
        workflow.sockets.push(socket.connection);
        await applyControlWord(workflow, controlEvent("resume", " fix the lint errors "));
      });

      it("sends the trimmed reply text as the prompt", () =>
        resumed(() => {
          expect(promptTexts(socket)).toEqual(["fix the lint errors"]);
        }));

      it("puts the task back to work", () =>
        resumed((workflow) => {
          expect(workflow.store.requireTask(TASK).status).toBe("working");
        }));
    });

    describe("a task paused while it was provisioning", () => {
      const resumed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { status: "provisioning" });
        await applyControlWord(workflow, controlEvent("pause"));
        await applyControlWord(workflow, controlEvent("resume"));
      });

      it("comes back as provisioning", () =>
        resumed((workflow) => {
          expect(workflow.store.requireTask(TASK)).toMatchObject({
            status: "provisioning",
            paused_at: null,
          });
        }));
    });

    describe("a task that is not paused", () => {
      const resumed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow);
        await applyControlWord(workflow, controlEvent("resume"));
      });

      it("posts nothing", () =>
        resumed((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("queues nothing", () =>
        resumed((workflow) => {
          expect(workflow.store.queue()).toEqual([]);
        }));
    });
  });

  describe("instruct", () => {
    describe("a task that is still provisioning", () => {
      const instructed = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow, { status: "provisioning" });
        await applyControlWord(workflow, controlEvent("instruct", "run the tests"));
      });

      it("queues the text", () =>
        instructed((workflow) => {
          expect(workflow.store.queue().map((row) => row.text)).toEqual(["run the tests"]);
        }));

      it("touches no sandbox", () =>
        instructed((workflow) => {
          expect(workflow.sandboxProvider.calls).toEqual([]);
        }));
    });
  });

  describe("a workflow with no task to control", () => {
    const controlled = scenario(freshRuntime, async (workflow) => {
      await applyControlWord(workflow, controlEvent("pause"));
      await applyControlWord(workflow, controlEvent("instruct", "hello"));
    });

    it("posts nothing", () =>
      controlled((workflow) => {
        expect(workflow.posted).toEqual([]);
      }));

    it("queues nothing", () =>
      controlled((workflow) => {
        expect(workflow.store.queue()).toEqual([]);
      }));
  });
});
