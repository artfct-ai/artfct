import type { ChatMethod, FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { seedTask, type FakeRuntime } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import {
  attachChat,
  gate,
  ScriptedChat,
  type ChatFailures,
  type ChatHolds,
  type Gate,
} from "../../../test/scripted-chat";
import { BOARD_COALESCE_S, flushBoards, markBoardDirty, onFlushBoard } from "./board";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const CHAT_KEY = "chat:C1:1.0";
const FIRST_TS = "1700000001.000100";
const SECOND_TS = "1700000002.000100";
const DELETED = "message not found";
const TEN_AM = Date.parse("2026-09-03T10:00:00Z");
const GONE = "storage gone";

function useChat(
  workflow: FakeRuntime,
  failures: ChatFailures = {},
  holds: ChatHolds = {},
): ScriptedChat {
  const chat = new ScriptedChat(failures, holds);
  attachChat(workflow, chat);
  return chat;
}

function methods(chat: FakeChat): ChatMethod[] {
  return chat.calls.map((call) => call.method);
}

function texts(chat: FakeChat, method: ChatMethod): string[] {
  return chat.argsOf(method).map((args) => String(args.at(-1)));
}

function logged(workflow: FakeRuntime, text: string): boolean {
  return workflow.lines.some((line) => line.includes(text));
}

function seedBoardTask(workflow: FakeRuntime, patch: Parameters<typeof seedTask>[1] = {}) {
  const task = seedTask(workflow, patch);
  workflow.store.setTodos(task.task_id, {
    entries: [{ content: "step one", priority: "medium", status: "pending" }],
  });
  return task;
}

function moveTodos(workflow: FakeRuntime, content: string) {
  workflow.store.setTodos(TASK, {
    entries: [{ content, priority: "medium", status: "pending" }],
  });
}

let chat: ScriptedChat;
let outcome: unknown;

describe("one writer at a time", () => {
  describe("a change made while an edit is in flight", () => {
    let held: Gate;
    let writing: Promise<void>;
    const inFlight = scenario(freshRuntime, async (workflow) => {
      held = gate();
      chat = useChat(workflow, {}, { updateMessage: held });
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
      workflow.store.patchTodoRow(TASK, { note: "FIRST" });
      writing = flushBoards(workflow, JOB);
      await held.reached;
      workflow.store.patchTodoRow(TASK, { note: "SECOND" });
      await flushBoards(workflow, JOB);
    });

    it("schedules a flush for after the write it found", () =>
      inFlight((workflow) => {
        expect(workflow.alarmsFor("flushBoard").at(-1)).toMatchObject({ delay: BOARD_COALESCE_S });
      }));

    describe("once the write finishes and the alarm fires", () => {
      const settled = scenario(inFlight, async (workflow) => {
        held.open();
        await writing;
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("edits the message twice", () =>
        settled(() => {
          expect(methods(chat)).toEqual(["postThreadMessage", "updateMessage", "updateMessage"]);
        }));

      it("sends both changes in the order they were made", () =>
        settled(() => {
          const edits = texts(chat, "updateMessage");
          expect(edits[0]).toContain("FIRST");
          expect(edits[1]).toContain("SECOND");
        }));
    });
  });

  describe("two changes while the alarm is being scheduled", () => {
    let held: Gate;
    let scheduling: Promise<void>;
    const holding = scenario(freshRuntime, async (workflow) => {
      useChat(workflow);
      seedBoardTask(workflow);
      held = gate();
      const schedule = workflow.scheduleAlarm.bind(workflow);
      workflow.scheduleAlarm = async (delay, method, payload) => {
        await held.hold();
        return schedule(delay, method, payload);
      };
      scheduling = markBoardDirty(workflow, JOB);
      await held.reached;
    });

    it("holds the place on the isolate, where its lifetime belongs", () =>
      holding((workflow) => {
        expect(workflow.store.todoRow(TASK)?.flush_schedule ?? null).toBeNull();
      }));

    describe("once both changes are through", () => {
      const scheduled = scenario(holding, async (workflow) => {
        const second = markBoardDirty(workflow, JOB);
        held.open();
        await Promise.all([scheduling, second]);
      });

      it("schedules one alarm for both", () =>
        scheduled((workflow) => {
          expect(workflow.alarmsFor("flushBoard")).toHaveLength(1);
        }));

      it("records that alarm on the todo row", () =>
        scheduled((workflow) => {
          const alarms = workflow.alarmsFor("flushBoard");
          expect(workflow.store.todoRow(TASK)?.flush_schedule).toBe(alarms[0]?.id);
        }));
    });
  });

  describe("a change whose alarm cannot be scheduled", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      useChat(workflow);
      seedBoardTask(workflow);
      workflow.scheduleAlarm = async () => {
        throw new Error(GONE);
      };
      outcome = await markBoardDirty(workflow, JOB);
    });

    it("leaves the caller alone", () =>
      failed(() => {
        expect(outcome).toBeUndefined();
      }));

    it("leaves nothing pending on the todo row", () =>
      failed((workflow) => {
        expect(workflow.store.todoRow(TASK)?.flush_schedule ?? null).toBeNull();
      }));

    it("logs why the flush was not scheduled", () =>
      failed((workflow) => {
        expect(logged(workflow, `board flush not scheduled: Error: ${GONE}`)).toBe(true);
      }));

    describe("and the next change after it", () => {
      const again = scenario(failed, (workflow) => markBoardDirty(workflow, JOB));

      it("gets to try again, so nothing is stuck", () =>
        again((workflow) => {
          expect(logged(workflow, `board flush not scheduled: Error: ${GONE}`)).toBe(true);
        }));
    });
  });

  describe("a pending alarm that cannot be cancelled", () => {
    const flushed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedBoardTask(workflow);
      await markBoardDirty(workflow, JOB);
      workflow.cancelAlarm = async () => {
        throw new Error(GONE);
      };
      outcome = await flushBoards(workflow, JOB);
    });

    it("leaves the caller alone", () =>
      flushed(() => {
        expect(outcome).toBeUndefined();
      }));

    it("posts the board anyway", () =>
      flushed(() => {
        expect(methods(chat)).toEqual(["postThreadMessage"]);
      }));

    it("logs the alarm it could not cancel", () =>
      flushed((workflow) => {
        expect(logged(workflow, "board flush alarm not cancelled")).toBe(true);
      }));
  });
});

describe("a board call that fails", () => {
  describe("a create that fails", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      useChat(workflow, { postThreadMessage: ["ratelimited"] });
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
    });

    it("keeps no message and no hash, so the next flush creates one", () =>
      failed((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
          message_id: null,
          hash: null,
        });
      }));

    describe("and the next flush after it, with nothing new to say", () => {
      const again = scenario(failed, (workflow) => flushBoards(workflow, JOB));

      it("posts the board and keeps the message", () =>
        again((workflow) => {
          expect(workflow.store.board(JOB, CHAT_KEY)?.message_id).toBe(SECOND_TS);
        }));
    });

    describe("and the implementation completing after it", () => {
      let scheduled: number;
      const done = scenario(failed, async (workflow) => {
        workflow.store.completeTodos(TASK);
        await markBoardDirty(workflow, JOB);
        scheduled = workflow.alarmsFor("flushBoard").length;
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("schedules the flush, though the list is complete", () =>
        done(() => {
          expect(scheduled).toBe(1);
        }));

      it("still creates the board, so a create keeps being retried", () =>
        done((workflow) => {
          expect(workflow.store.board(JOB, CHAT_KEY)?.message_id).toBe(SECOND_TS);
        }));
    });
  });

  describe("a create that failed before the reopen", () => {
    const reopened = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow, { postThreadMessage: ["ratelimited"] });
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
      workflow.store.relocateBoards(JOB);
      await flushBoards(workflow, JOB);
    });

    it("posts the board once and deletes nothing", () =>
      reopened(() => {
        expect(methods(chat)).toEqual(["postThreadMessage", "postThreadMessage"]);
      }));

    it("keeps the message and moves no second time", () =>
      reopened((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
          message_id: SECOND_TS,
          relocate: 0,
        });
      }));
  });

  describe("an edit that fails", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow, { updateMessage: ["ratelimited"] });
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
      moveTodos(workflow, "step two");
      outcome = await flushBoards(workflow, JOB);
    });

    it("leaves the caller alone", () =>
      failed(() => {
        expect(outcome).toBeUndefined();
      }));

    it("clears the hash so the next flush tries again, and keeps the message", () =>
      failed((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
          hash: null,
          message_id: FIRST_TS,
        });
      }));

    it("schedules no retry of its own", () =>
      failed((workflow) => {
        expect(workflow.alarmsFor("flushBoard")).toHaveLength(0);
      }));

    describe("and the next flush after it", () => {
      const again = scenario(failed, (workflow) => flushBoards(workflow, JOB));

      it("edits the message again", () =>
        again(() => {
          expect(methods(chat)).toEqual(["postThreadMessage", "updateMessage", "updateMessage"]);
        }));

      it("stores the hash of what it wrote", () =>
        again((workflow) => {
          expect(workflow.store.board(JOB, CHAT_KEY)?.hash).toHaveLength(8);
        }));
    });
  });

  describe("a board message a person deleted", () => {
    const recreated = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow, { updateMessage: [DELETED, DELETED] });
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
      moveTodos(workflow, "step two");
      await flushBoards(workflow, JOB);
    });

    it("posts the board again and keeps the new message", () =>
      recreated((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
          recreated: 1,
          message_id: SECOND_TS,
        });
      }));

    describe("and the new message deleted too", () => {
      const gone = scenario(recreated, async (workflow) => {
        moveTodos(workflow, "step three");
        await flushBoards(workflow, JOB);
      });

      it("re-creates the message no more", () =>
        gone(() => {
          expect(methods(chat)).toEqual([
            "postThreadMessage",
            "updateMessage",
            "postThreadMessage",
            "updateMessage",
          ]);
        }));
    });
  });
});
