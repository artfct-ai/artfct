import type { ChatMethod } from "@artfct-ai/adapters/test/fake-chat";
import { describe, expect, it } from "bun:test";
import { FakeRuntime, seedTask } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { scenario, type Scenario } from "../../../test/scenario";
import {
  attachChat,
  BOARD_THREAD,
  gate,
  ScriptedChat,
  type ChatFailures,
} from "../../../test/scripted-chat";
import { testEnv } from "../../../test/test-env";
import type { WorkflowDb } from "../store/db";
import { flushBoards } from "./board";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const CHAT_KEY = "chat:C1:1.0";
const PREVIOUS_TS = "1699999999.000100";
const FIRST_TS = "1700000001.000100";
const SECOND_TS = "1700000002.000100";
const TEN_AM = Date.parse("2026-09-03T10:00:00Z");

let db: WorkflowDb;
let chat: ScriptedChat;
let outcome: unknown;

const onFreshDb: Scenario<FakeRuntime> = async (run) => {
  db = openMemoryDb();
  await run(new FakeRuntime(db, testEnv()));
};

function useChat(workflow: FakeRuntime, failures: ChatFailures = {}): void {
  chat = new ScriptedChat(failures);
  attachChat(workflow, chat);
  workflow.clock = TEN_AM;
}

function restart(workflow: FakeRuntime): FakeRuntime {
  const restarted = new FakeRuntime(db, testEnv());
  attachChat(restarted, chat);
  restarted.clock = workflow.clock;
  return restarted;
}

function seedBoardTask(workflow: FakeRuntime): void {
  seedTask(workflow);
  moveTodos(workflow, "step one");
}

function moveTodos(workflow: FakeRuntime, content: string): void {
  workflow.store.setTodos(TASK, {
    entries: [{ content, priority: "medium", status: "pending" }],
  });
}

function seedBoardToRelocate(workflow: FakeRuntime): void {
  seedBoardTask(workflow);
  workflow.store.insertBoard(JOB, CHAT_KEY, BOARD_THREAD);
  workflow.store.updateBoard(JOB, CHAT_KEY, { message_id: PREVIOUS_TS, hash: "00000000" });
  workflow.store.relocateBoards(JOB);
}

function methods(): ChatMethod[] {
  return chat.calls.map((call) => call.method);
}

function logged(workflow: FakeRuntime, text: string): boolean {
  return workflow.lines.some((line) => line.includes(text));
}

describe("a reopened board", () => {
  const relocated = scenario(onFreshDb, async (workflow) => {
    useChat(workflow);
    seedBoardTask(workflow);
    await flushBoards(workflow, JOB);
    workflow.store.relocateBoards(JOB);
    await flushBoards(workflow, JOB);
  });

  it("posts the board at the end of the thread though nothing on it changed", () =>
    relocated(() => {
      expect(methods()).toEqual(["postThreadMessage", "postThreadMessage", "deleteMessage"]);
    }));

  it("keeps the new message and moves no more", () =>
    relocated((workflow) => {
      expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
        message_id: SECOND_TS,
        relocate: 0,
      });
    }));

  it("deletes the previous message", () =>
    relocated(() => {
      expect(chat.argsOf("deleteMessage")).toEqual([["C1", FIRST_TS]]);
    }));

  describe("and a change after it", () => {
    const changed = scenario(relocated, async (workflow) => {
      moveTodos(workflow, "step two");
      await flushBoards(workflow, JOB);
    });

    it("edits the new message", () =>
      changed(() => {
        expect(chat.argsOf("updateMessage").map((args) => args[1])).toEqual([SECOND_TS]);
      }));
  });

  describe("and nothing new after it", () => {
    const unchanged = scenario(relocated, (workflow) => flushBoards(workflow, JOB));

    it("sends nothing", () =>
      unchanged(() => {
        expect(methods()).toHaveLength(3);
      }));
  });
});

describe("a reopened board whose new message cannot be posted", () => {
  const failed = scenario(onFreshDb, async (workflow) => {
    useChat(workflow, { postThreadMessage: ["ratelimited"] });
    seedBoardToRelocate(workflow);
    await flushBoards(workflow, JOB);
  });

  it("keeps the previous message and still moves on the next flush", () =>
    failed((workflow) => {
      expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
        message_id: PREVIOUS_TS,
        relocate: 1,
      });
    }));

  it("deletes nothing", () =>
    failed(() => {
      expect(chat.argsOf("deleteMessage")).toEqual([]);
    }));

  describe("and the next flush", () => {
    const again = scenario(failed, (workflow) => flushBoards(workflow, JOB));

    it("moves the board and deletes the previous message", () =>
      again((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.message_id).toBe(SECOND_TS);
        expect(chat.argsOf("deleteMessage")).toEqual([["C1", PREVIOUS_TS]]);
      }));
  });
});

describe("a previous board message that cannot be deleted", () => {
  const stubbed = scenario(onFreshDb, async (workflow) => {
    useChat(workflow, { deleteMessage: ["cant_delete_message"] });
    seedBoardToRelocate(workflow);
    await flushBoards(workflow, JOB);
  });

  it("keeps the new message", () =>
    stubbed((workflow) => {
      expect(workflow.store.board(JOB, CHAT_KEY)).toMatchObject({
        message_id: FIRST_TS,
        relocate: 0,
      });
    }));

  it("edits the previous message into a link to the new one", () =>
    stubbed(() => {
      expect(chat.argsOf("updateMessage")).toEqual([
        [
          "C1",
          PREVIOUS_TS,
          `This board moved to the [end of the thread](https://chat.test/C1/${FIRST_TS}).`,
        ],
      ]);
    }));

  describe("when the link cannot be written either", () => {
    const leftAsIs = scenario(onFreshDb, async (workflow) => {
      useChat(workflow, {
        deleteMessage: ["cant_delete_message"],
        updateMessage: ["cant_update_message"],
      });
      seedBoardToRelocate(workflow);
      outcome = await flushBoards(workflow, JOB);
    });

    it("leaves the caller alone", () =>
      leftAsIs(() => {
        expect(outcome).toBeUndefined();
      }));

    it("keeps the new message", () =>
      leftAsIs((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.message_id).toBe(FIRST_TS);
      }));

    it("logs that the previous message stays as it is", () =>
      leftAsIs((workflow) => {
        expect(logged(workflow, "left as is: Error: cant_update_message")).toBe(true);
      }));
  });
});

describe("a restart after the new board is stored and before the delete", () => {
  let restarted: FakeRuntime;
  const afterRestart = scenario(onFreshDb, async (workflow) => {
    useChat(workflow);
    seedBoardToRelocate(workflow);
    const died = gate();
    workflow.notifier.deleteBoard = () => died.hold();
    void flushBoards(workflow, JOB);
    await died.reached;
    restarted = restart(workflow);
    moveTodos(restarted, "step two");
    await flushBoards(restarted, JOB);
  });

  it("leaves the previous message in the thread, referenced by no board", () =>
    afterRestart(() => {
      expect(chat.argsOf("deleteMessage")).toEqual([]);
      expect(chat.argsOf("updateMessage").map((args) => args[1])).not.toContain(PREVIOUS_TS);
    }));

  it("edits only the new board", () =>
    afterRestart(() => {
      expect(methods()).toEqual(["postThreadMessage", "updateMessage"]);
      expect(chat.argsOf("updateMessage")[0]?.[1]).toBe(FIRST_TS);
    }));
});

describe("a restart after the new board is posted and before it is stored", () => {
  let restarted: FakeRuntime;
  const afterRestart = scenario(onFreshDb, async (workflow) => {
    useChat(workflow);
    seedBoardToRelocate(workflow);
    const died = gate();
    const createBoard = workflow.notifier.createBoard.bind(workflow.notifier);
    workflow.notifier.createBoard = async (channel, text) => {
      const messageId = await createBoard(channel, text);
      await died.hold();
      return messageId;
    };
    void flushBoards(workflow, JOB);
    await died.reached;
    restarted = restart(workflow);
    await flushBoards(restarted, JOB);
  });

  it("posts the board at the end of the thread again", () =>
    afterRestart(() => {
      expect(methods()).toEqual(["postThreadMessage", "postThreadMessage", "deleteMessage"]);
    }));

  it("keeps the second of the two tail boards", () =>
    afterRestart(() => {
      expect(restarted.store.board(JOB, CHAT_KEY)).toMatchObject({
        message_id: SECOND_TS,
        relocate: 0,
      });
    }));

  it("deletes the previous message and leaves the first tail board in the thread", () =>
    afterRestart(() => {
      expect(chat.argsOf("deleteMessage")).toEqual([["C1", PREVIOUS_TS]]);
    }));
});
