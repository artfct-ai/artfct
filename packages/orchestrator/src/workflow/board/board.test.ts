import { FakeChat, type ChatMethod } from "@artfct-ai/adapters/test/fake-chat";
import { FakeTracker } from "@artfct-ai/adapters/test/fake-tracker";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { Notifier } from "../../notify/notifier";
import {
  fakeConnection,
  JUDGE_ENTRY,
  patchStagePolishers,
  patchStageReviewers,
  REVIEW_JOB,
  seedPullRequestTask,
  seedReviewerRun,
  seedTask,
  type FakeRuntime,
} from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { completeJob, failTask } from "../lifecycle";
import { promptTask } from "../task/harness/prompt-queue";
import { advanceArtifactPastEntry, settleRefinersForAuthor, startRefiner } from "../refiner/loop";
import { markArtifactReady } from "../refiner/outcome";
import {
  BOARD_COALESCE_S,
  boardTask,
  channelKey,
  flushBoards,
  hashText,
  markBoardDirty,
  onFlushBoard,
} from "./board";

const TASK = "wf_x.1";
const JOB = "wf_x-1";
const THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;
const SESSION = { source: "tracker", session_id: "s1", issue_id: "issue-1" } as const;
const CHAT_KEY = "chat:C1:1.0";
const FIRST_TS = "1700000001.000100";
const TEN_AM = Date.parse("2026-09-03T10:00:00Z");

function useChat(workflow: FakeRuntime, tracker: FakeTracker | null = null): FakeChat {
  const chat = new FakeChat();
  workflow.notifier = new Notifier(
    { tracker: async () => tracker, chat, documents: async () => null },
    (entry) => workflow.store.writeOutbox(entry),
  );
  workflow.state.reply_targets = [THREAD];
  return chat;
}

function methods(chat: FakeChat): ChatMethod[] {
  return chat.calls.map((call) => call.method);
}

function texts(chat: FakeChat, method: ChatMethod): string[] {
  return chat.argsOf(method).map((args) => String(args.at(-1)));
}

const PHASE_LINES = /^☐ (review|polish)|^☑ (review|polish)|Ready for Humans$/;

function phaseLines(board: string | undefined): string[] {
  return (board ?? "").split("\n").filter((text) => PHASE_LINES.test(text));
}

function seedBoardTask(workflow: FakeRuntime, patch: Parameters<typeof seedTask>[1] = {}) {
  const task = seedTask(workflow, patch);
  workflow.store.setTodos(task.task_id, {
    entries: [{ content: "step one", priority: "medium", status: "pending" }],
  });
  return task;
}

let chat: FakeChat;

describe("flushBoards", () => {
  describe("a task whose board goes to a Slack thread and two Linear sessions", () => {
    let tracker: FakeTracker;
    const created = scenario(freshRuntime, async (workflow) => {
      tracker = new FakeTracker({ commentId: "comment-9" });
      chat = useChat(workflow, tracker);
      workflow.state.reply_targets = [THREAD, SESSION, { ...SESSION, session_id: "s2" }];
      seedBoardTask(workflow, { issue_id: "issue-1", issue_key: "ENG-1" });
      await flushBoards(workflow, JOB);
    });

    it("creates one board per place and keeps its message id", () =>
      created((workflow) => {
        const boards = workflow.store.boards(JOB);
        const keyed = Object.fromEntries(
          boards.map((board) => [board.channel_key, board.message_id]),
        );
        expect(keyed).toEqual({ [CHAT_KEY]: FIRST_TS, "tracker:issue-1": "comment-9" });
      }));

    it("keeps a hash of the text it wrote", () =>
      created((workflow) => {
        expect(workflow.store.boards(JOB)[0]?.hash).toHaveLength(8);
      }));

    it("comments once on the Linear issue", () =>
      created(() => {
        expect(tracker.argsOf("commentOnIssue")).toEqual([["issue-1", expect.any(String)]]);
      }));

    it("posts once in the Slack thread", () =>
      created(() => {
        expect(methods(chat)).toEqual(["postThreadMessage"]);
      }));

    it("logs the board it created", () =>
      created((workflow) => {
        expect(workflow.lines).toContain(`board of ${JOB} created on ${CHAT_KEY}`);
      }));
  });

  describe("a todo list with a link in it, flushed twice with no change between", () => {
    const flushed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      workflow.patchState({ name: "Fix the login redirect" });
      seedBoardTask(workflow, { issue_key: "ENG-1" });
      workflow.store.setTodos(TASK, {
        entries: [
          {
            content: "Open https://github.com/acme/app/pull/1",
            priority: "high",
            status: "in_progress",
          },
        ],
      });
      await flushBoards(workflow, JOB);
      workflow.clock += 20 * 60_000;
      await flushBoards(workflow, JOB);
    });

    it("skips the API when nothing changed, however far the clock moved", () =>
      flushed(() => {
        expect(methods(chat)).toEqual(["postThreadMessage"]);
      }));

    it("names the workflow, the stage, the ticket and the lifecycle", () =>
      flushed(() => {
        expect(texts(chat, "postThreadMessage")[0]).toContain(
          "*Fix the login redirect · design · ENG-1 · working*",
        );
      }));

    it("opens the stamp with the task number and closes it with the time it wrote", () =>
      flushed(() => {
        const stamp = texts(chat, "postThreadMessage")[0]?.split("\n")[1];
        expect(stamp).toMatch(/^Job 1 · started \d\d:\d\d · updated 10:00 UTC$/);
      }));

    it("renders the entry with the link removed", () =>
      flushed(() => {
        const [text] = texts(chat, "postThreadMessage");
        expect(text).toContain("☐ Open (link removed) ← working");
        expect(text).not.toContain("http");
      }));

    it("posts in the thread of the reply target", () =>
      flushed(() => {
        expect(chat.argsOf("postThreadMessage")[0]?.slice(0, 2)).toEqual(["C1", "1.0"]);
      }));
  });

  describe("a board whose text changed", () => {
    const edited = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      await flushBoards(workflow, JOB);
      workflow.store.setTodos(TASK, {
        entries: [{ content: "Write tests", priority: "medium", status: "pending" }],
      });
      await flushBoards(workflow, JOB);
    });

    it("edits the message instead of posting again", () =>
      edited(() => {
        expect(methods(chat)).toEqual(["postThreadMessage", "updateMessage"]);
      }));

    it("edits the message it posted", () =>
      edited(() => {
        expect(chat.argsOf("updateMessage")[0]?.slice(0, 2)).toEqual(["C1", FIRST_TS]);
      }));

    it("sends the new list", () =>
      edited(() => {
        expect(texts(chat, "updateMessage")[0]).toContain("☐ Write tests");
      }));

    it("keeps the message id", () =>
      edited((workflow) => {
        expect(workflow.store.boards(JOB)[0]?.message_id).toBe(FIRST_TS);
      }));

    it("logs the edit", () =>
      edited((workflow) => {
        expect(workflow.lines).toContain(`board of ${JOB} edited on ${CHAT_KEY}`);
      }));
  });

  describe("two changes before anything flushes", () => {
    const dirty = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedBoardTask(workflow);
      await markBoardDirty(workflow, JOB);
      await markBoardDirty(workflow, JOB);
    });

    it("coalesces them into one alarm", () =>
      dirty((workflow) => {
        expect(workflow.alarmsFor("flushBoard")).toMatchObject([
          { delay: BOARD_COALESCE_S, payload: { job_id: JOB } },
        ]);
      }));

    it("records the alarm on the todo row", () =>
      dirty((workflow) => {
        const alarms = workflow.alarmsFor("flushBoard");
        expect(workflow.store.todoRow(TASK)?.flush_schedule).toBe(alarms[0]?.id);
      }));

    describe("and then the alarm fires", () => {
      const fired = scenario(dirty, (workflow) => onFlushBoard(workflow, { job_id: JOB }));

      it("clears the schedule", () =>
        fired((workflow) => {
          expect(workflow.store.todoRow(TASK)?.flush_schedule).toBeNull();
        }));

      it("posts the board once", () =>
        fired(() => {
          expect(methods(chat)).toEqual(["postThreadMessage"]);
        }));
    });
  });

  describe("a class change that flushes before the pending alarm fires", () => {
    let alarmId: string;
    const flushed = scenario(freshRuntime, async (workflow) => {
      useChat(workflow);
      seedBoardTask(workflow);
      await markBoardDirty(workflow, JOB);
      alarmId = workflow.alarmsFor("flushBoard")[0]!.id;
      await flushBoards(workflow, JOB);
    });

    it("cancels the pending alarm", () =>
      flushed((workflow) => {
        expect(workflow.cancelled).toContain(alarmId);
      }));

    it("clears the schedule", () =>
      flushed((workflow) => {
        expect(workflow.store.todoRow(TASK)?.flush_schedule).toBeNull();
      }));
  });
});

describe("the lifetime of a board", () => {
  describe("a board on a working task", () => {
    const posted = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      workflow.store.setTodos(TASK, {
        entries: [{ content: "Fix it", priority: "high", status: "in_progress" }],
      });
      await flushBoards(workflow, JOB);
    });

    describe("when the task is sent back for review", () => {
      const inReview = scenario(posted, async (workflow) => {
        workflow.store.updateTask(TASK, { status: "in_review" });
        workflow.clock! += 60_000;
        await flushBoards(workflow, JOB);
      });

      it("edits the board to the new lifecycle word", () =>
        inReview(() => {
          expect(texts(chat, "updateMessage")[0]).toContain("in review");
        }));

      describe("and then the task fails", () => {
        const failed = scenario(inReview, async (workflow) => {
          workflow.store.updateTask(TASK, { status: "failed" });
          workflow.clock! += 60_000;
          await flushBoards(workflow, JOB);
        });

        it("keeps the one board it created", () =>
          failed((workflow) => {
            expect(workflow.store.boards(JOB)).toHaveLength(1);
          }));

        it("edits it again instead of posting a new one", () =>
          failed(() => {
            expect(methods(chat)).toEqual(["postThreadMessage", "updateMessage", "updateMessage"]);
          }));

        it("names the item that stayed open", () =>
          failed(() => {
            expect(texts(chat, "updateMessage")[1]).toContain("failed, 1 item still open");
          }));
      });
    });
  });

  describe("an implementation that completes while the harness is on its last item", () => {
    const completed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      seedBoardTask(workflow, { stage: "implement" });
      workflow.store.setTodos(TASK, {
        entries: [
          { content: "Run the tests", priority: "high", status: "completed" },
          { content: "Opening the pull request", priority: "high", status: "in_progress" },
          { content: "Update the README", priority: "low", status: "pending" },
        ],
      });
      await flushBoards(workflow, JOB);
      workflow.store.updateTask(TASK, { status: "in_review" });
      workflow.store.completeTodos(TASK);
      await flushBoards(workflow, JOB);
    });

    it("checks every item and drops the working marker", () =>
      completed(() => {
        const [edit] = texts(chat, "updateMessage");
        expect(edit).toContain("☑ Opening the pull request");
        expect(edit).toContain("☑ Update the README");
        expect(edit).not.toContain("☐");
        expect(edit).not.toContain("← working");
      }));

    it("completes every entry in the stored list", () =>
      completed((workflow) => {
        const entries = workflow.store.todoRow(TASK)?.todos?.entries ?? [];
        expect(entries.map((entry) => entry.status)).toEqual([
          "completed",
          "completed",
          "completed",
        ]);
      }));

    describe("when a prompt moves the task back to working", () => {
      const prompted = scenario(completed, async (workflow) => {
        workflow.clock! += 60_000;
        workflow.store.updateTask(TASK, { status: "working" });
        await flushBoards(workflow, JOB);
      });

      it("reports what the task row says", () =>
        prompted(() => {
          expect(texts(chat, "updateMessage").at(-1)).toContain("implement · working");
        }));
    });

    describe("when the task ends", () => {
      const done = scenario(completed, async (workflow) => {
        workflow.store.updateTask(TASK, { status: "done" });
        await flushBoards(workflow, JOB);
      });

      it("reports no item still open", () =>
        done(() => {
          const edit = texts(chat, "updateMessage")[1];
          expect(edit).toContain("· done");
          expect(edit).not.toContain("still open");
        }));
    });
  });

  describe("a board whose implementation completed at the artifact", () => {
    const complete = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      seedBoardTask(workflow);
      workflow.store.setTodos(TASK, {
        entries: [{ content: "Open the pull request", priority: "high", status: "completed" }],
      });
      await flushBoards(workflow, JOB);
      workflow.store.upsertArtifact({
        job_id: JOB,
        kind: "page",
        external_url: "https://notion.so/acme/Design-1",
        ref: { kind: "page", page_id: "page-1" },
      });
      workflow.store.updateTask(TASK, { status: "in_review" });
      workflow.store.completeTodos(TASK);
      await flushBoards(workflow, JOB);
    });

    it("edits the board to the lifecycle word of the task row", () =>
      complete(() => {
        expect(texts(chat, "updateMessage")[0]).toContain("in review");
      }));

    describe("when a review run moves the harness list afterwards", () => {
      const moved = scenario(complete, async (workflow) => {
        workflow.clock! += 20 * 60_000;
        workflow.store.setTodos(TASK, {
          entries: [{ content: "Rename the helper", priority: "high", status: "in_progress" }],
        });
        await markBoardDirty(workflow, JOB);
      });

      it("schedules the flush, so a review transition can ride the same door", () =>
        moved((workflow) => {
          expect(workflow.alarmsFor("flushBoard")).toHaveLength(1);
        }));

      describe("and that flush runs", () => {
        const flushed = scenario(moved, (workflow) => onFlushBoard(workflow, { job_id: JOB }));

        it("sends nothing, because the store kept the list as it was", () =>
          flushed(() => {
            expect(methods(chat)).toEqual(["postThreadMessage", "updateMessage"]);
          }));

        describe("and then the task ends", () => {
          const done = scenario(flushed, async (workflow) => {
            workflow.store.updateTask(TASK, { status: "done" });
            await flushBoards(workflow, JOB);
          });

          it("edits the board once more", () =>
            done(() => {
              expect(texts(chat, "updateMessage")).toHaveLength(2);
            }));

          it("shows the end of the task and the time it wrote", () =>
            done(() => {
              const edit = texts(chat, "updateMessage")[1];
              expect(edit).toContain("· done");
              expect(edit).toContain("updated 10:20 UTC");
            }));

          it("keeps the list the implementation ended with", () =>
            done(() => {
              const edit = texts(chat, "updateMessage")[1];
              expect(edit).toContain("Open the pull request");
              expect(edit).not.toContain("Rename the helper");
            }));
        });
      });
    });
  });
});

function seedHeldTask(workflow: FakeRuntime, seed: Parameters<typeof seedPullRequestTask>[2]) {
  workflow.patchState({ name: "Fix the login redirect" });
  return seedPullRequestTask(workflow, { issue_key: "ENG-1" }, seed);
}

describe("the phases on the checklist", () => {
  describe("a harness that reported no list, holding an artifact a reviewer is reading", () => {
    const held = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedHeldTask(workflow, { refiner_task_id: "wf_x.9" });
      seedTask(workflow, {
        task_id: "wf_x.9",
        role: "reviewer",
        job_id: JOB,
        refiner_index: 0,
      });
      await flushBoards(workflow, JOB);
    });

    it("prints the review phase, the humans line, and no fallback line", () =>
      held(() => {
        expect(texts(chat, "postThreadMessage")[0]?.split("\n").slice(2)).toEqual([
          "",
          "☐ review ← run 1 · working",
          "☐ Ready for Humans",
        ]);
      }));
  });

  describe("a stage that declares a polisher after its reviewer", () => {
    const polishing = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      patchStagePolishers(workflow, [{ name: "Comment pass", skill: "technical-writer" }]);
      seedHeldTask(workflow, { refiner_task_id: "wf_x.9" });
      seedTask(workflow, {
        task_id: "wf_x.9",
        role: "polisher",
        job_id: JOB,
        refiner_index: 1,
      });
      await flushBoards(workflow, JOB);
    });

    it("lists review, then polish, then the humans", () =>
      polishing(() => {
        expect(texts(chat, "postThreadMessage")[0]?.split("\n").slice(2)).toEqual([
          "",
          "☑ review",
          "☐ polish ← run 1 · working",
          "☐ Ready for Humans",
        ]);
      }));
  });

  describe("an artifact recorded before its first reviewer exists", () => {
    const queued = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedHeldTask(workflow, {});
      await flushBoards(workflow, JOB);
    });

    it("claims no review has run", () =>
      queued(() => {
        expect(texts(chat, "postThreadMessage")[0]?.split("\n").slice(-2)).toEqual([
          "☐ review",
          "☐ Ready for Humans",
        ]);
      }));

    describe("and then a reviewer that read it and went", () => {
      const routing = scenario(queued, async (workflow) => {
        const reviewer = seedTask(workflow, {
          task_id: "wf_x.9",
          role: "reviewer",
          job_id: JOB,
          refiner_index: 0,
        });
        workflow.store.updateTask(reviewer.task_id, { status: "done" });
        workflow.store.setArtifactRefinerRun(JOB, "wf_x.9");
        await flushBoards(workflow, JOB);
      });

      it("keeps review open and says its findings are with the author", () =>
        routing(() => {
          expect(texts(chat, "updateMessage")[0]?.split("\n").slice(-2)).toEqual([
            "☐ review ← run 1 · left findings, now with the author",
            "☐ Ready for Humans",
          ]);
        }));

      describe("and then the humans get it", () => {
        const ready = scenario(routing, async (workflow) => {
          workflow.store.advanceArtifact(JOB, ["drafted"], "ready");
          await flushBoards(workflow, JOB);
        });

        it("completes review and the humans line", () =>
          ready(() => {
            const edit = texts(chat, "updateMessage")[1];
            expect(edit).toContain("☑ review");
            expect(edit).toContain("☑ Ready for Humans");
          }));
      });
    });
  });

  describe("a stage of a judge and a findings reviewer whose judge is reading the artifact", () => {
    const aligning = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      patchStageReviewers(workflow, [
        JUDGE_ENTRY,
        { name: "Code Review", mode: "findings", skill: "implement-review" },
      ]);
      seedHeldTask(workflow, { refiner_task_id: "wf_x.9" });
      seedTask(workflow, {
        task_id: "wf_x.9",
        role: "reviewer",
        job_id: JOB,
        refiner_index: 0,
      });
      await flushBoards(workflow, JOB);
    });

    it("prints one review line for both reviewers and names neither", () =>
      aligning(() => {
        const board = texts(chat, "postThreadMessage")[0] ?? "";
        expect(board.split("\n").slice(-2)).toEqual([
          "☐ review ← run 1 · working",
          "☐ Ready for Humans",
        ]);
        expect(board).not.toContain("alignment");
        expect(board).not.toContain("Code review");
      }));

    describe("when that reviewer ends and code cannot tell what it concluded", () => {
      const awaited = scenario(aligning, async (workflow) => {
        workflow.store.updateTask("wf_x.9", { status: "done" });
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("says review waits for a ruling", () =>
        awaited(() => {
          expect(texts(chat, "updateMessage").at(-1)).toContain(
            "☐ review ← run 1 · waiting for your ruling",
          );
        }));
    });

    describe("when that reviewer's conclusion was ruled a rejection", () => {
      const rejected = scenario(aligning, async (workflow) => {
        workflow.store.updateTask("wf_x.9", {
          status: "done",
          result: { kind: "ruling", revision: "abc123", ruling: "rejected", reason: "Rewrite it." },
        });
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("says the rejection is with the author", () =>
        rejected(() => {
          expect(texts(chat, "updateMessage").at(-1)).toContain(
            "☐ review ← run 1 · rejected, now with the author",
          );
        }));
    });

    describe("when that reviewer ends clean and the next entry starts", () => {
      const handedOn = scenario(aligning, async (workflow) => {
        workflow.store.updateTask("wf_x.9", { status: "done" });
        await advanceArtifactPastEntry(workflow, workflow.store.requireTask(TASK), 0);
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("keeps review open on its first run while the second reviewer starts", () =>
        handedOn(() => {
          expect(texts(chat, "updateMessage").at(-1)?.split("\n").slice(-2)).toEqual([
            "☐ review ← run 1 · starting",
            "☐ Ready for Humans",
          ]);
        }));
    });
  });

  describe("an artifact recorded and settled in one turn", () => {
    const recorded = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedHeldTask(workflow, {});
      workflow.store.setTodos(TASK, {
        entries: [{ content: "Open the pull request", priority: "high", status: "in_progress" }],
      });
      await flushBoards(workflow, JOB);
      workflow.store.updateTask(TASK, { status: "in_review" });
      workflow.store.completeTodos(TASK);
      await flushBoards(workflow, JOB);
      await settleRefinersForAuthor(workflow, workflow.store.requireTask(TASK));
      await flushBoards(workflow, JOB);
    });

    it("never claims a review that has not run", () =>
      recorded(() => {
        const written = [...texts(chat, "postThreadMessage"), ...texts(chat, "updateMessage")];
        expect(written.filter((text) => text.includes("☑ review"))).toEqual([]);
      }));

    it("opens review once the first reviewer starts", () =>
      recorded(() => {
        expect(texts(chat, "updateMessage").at(-1)).toContain("☐ review ← run 1 · starting");
      }));
  });

  describe("a task that completes while a reviewer still holds its artifact", () => {
    const completed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedHeldTask(workflow, { refiner_task_id: "wf_x.9" });
      seedTask(workflow, {
        task_id: "wf_x.9",
        role: "reviewer",
        job_id: JOB,
        refiner_index: 0,
      });
      await flushBoards(workflow, JOB);
      await completeJob(workflow, workflow.store.requireTask(TASK), "designed");
    });

    it("ends the review and hands the artifact over before the board it keeps", () =>
      completed(() => {
        const last = texts(chat, "updateMessage").at(-1)?.split("\n") ?? [];
        expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · complete*");
        expect(last.slice(-2)).toEqual(["☑ review", "☑ Ready for Humans"]);
      }));

    it("gives the artifact to the humans, which the review was holding", () =>
      completed((workflow) => {
        expect(workflow.store.artifact(JOB)?.status).toBe("ready");
      }));

    it("tells them where it is, since the announcement was held for the review", () =>
      completed((workflow) => {
        expect(workflow.posted.filter((event) => event.type === "artifact_ready")).toHaveLength(1);
      }));

    it("leaves no flush pending, so that board is the last one", () =>
      completed((workflow) => {
        expect(workflow.alarmsFor("flushBoard")).toEqual([]);
      }));
  });

  describe("a task that fails while a reviewer still holds its artifact", () => {
    const failed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      seedHeldTask(workflow, { refiner_task_id: "wf_x.9" });
      seedTask(workflow, {
        task_id: "wf_x.9",
        role: "reviewer",
        job_id: JOB,
        refiner_index: 0,
      });
      await flushBoards(workflow, JOB);
      await failTask(workflow, workflow.store.requireTask(TASK), "sandbox gone");
    });

    it("ends the same way a completed task does", () =>
      failed(() => {
        const last = texts(chat, "updateMessage").at(-1)?.split("\n") ?? [];
        expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · failed*");
        expect(last.slice(-2)).toEqual(["☑ review", "☑ Ready for Humans"]);
      }));

    it("writes the channel once, never a wrong board it then corrects", () =>
      failed(() => {
        expect(texts(chat, "updateMessage")).toHaveLength(1);
      }));
  });

  describe("a stage of two reviewers and two polishers", () => {
    const ENTRY_NAMES = ["alignment", "Code review", "Comment pass", "technical writer"];

    const declared = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      patchStageReviewers(workflow, [
        JUDGE_ENTRY,
        { name: "Code review", mode: "findings", skill: "implement-review" },
      ]);
      patchStagePolishers(workflow, [
        { name: "Comment pass", skill: "code-cleaner" },
        { name: "technical writer", skill: "technical-writer" },
      ]);
      seedHeldTask(workflow, {});
      await flushBoards(workflow, JOB);
    });

    it("prints exactly review, polish, and the humans line", () =>
      declared(() => {
        expect(texts(chat, "postThreadMessage")[0]?.split("\n").slice(-3)).toEqual([
          "☐ review",
          "☐ polish",
          "☐ Ready for Humans",
        ]);
      }));

    it("names no entry", () =>
      declared(() => {
        for (const name of ENTRY_NAMES) {
          expect(texts(chat, "postThreadMessage")[0]).not.toContain(name);
        }
      }));

    describe("when the second reviewer runs a second run", () => {
      const secondRound = scenario(declared, async (workflow) => {
        const author = workflow.store.requireTask(TASK);
        await startRefiner(workflow, author, 0);
        await startRefiner(workflow, author, 1);
        await startRefiner(workflow, author, 1);
        await onFlushBoard(workflow, { job_id: JOB });
      });

      it("counts the most runs any reviewer has had, not the refiner runs", () =>
        secondRound(() => {
          expect(phaseLines(texts(chat, "updateMessage").at(-1))).toEqual([
            "☐ review ← run 2 · starting",
            "☐ polish",
            "☐ Ready for Humans",
          ]);
        }));

      it("prints no task number on the open line", () =>
        secondRound(() => {
          expect(texts(chat, "updateMessage").at(-1)).not.toMatch(/← .*task/);
        }));

      describe("and then the first polisher starts", () => {
        const polishing = scenario(secondRound, async (workflow) => {
          await startRefiner(workflow, workflow.store.requireTask(TASK), 2);
          await onFlushBoard(workflow, { job_id: JOB });
        });

        it("completes review while the polisher runs", () =>
          polishing(() => {
            expect(phaseLines(texts(chat, "updateMessage").at(-1))).toEqual([
              "☑ review",
              "☐ polish ← run 1 · starting",
              "☐ Ready for Humans",
            ]);
          }));

        it("still names no entry", () =>
          polishing(() => {
            for (const name of ENTRY_NAMES) {
              expect(texts(chat, "updateMessage").at(-1)).not.toContain(name);
            }
          }));

        describe("and then the second polisher starts", () => {
          const secondPolisher = scenario(polishing, async (workflow) => {
            await startRefiner(workflow, workflow.store.requireTask(TASK), 3);
            await onFlushBoard(workflow, { job_id: JOB });
          });

          it("counts the polish rounds apart from the review rounds", () =>
            secondPolisher(() => {
              expect(texts(chat, "updateMessage").at(-1)).toContain("☐ polish ← run 1 · starting");
            }));
        });
      });
    });
  });

  describe("an artifact the humans got, on a stage of a reviewer and a polisher", () => {
    const delivered = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.clock = TEN_AM;
      patchStagePolishers(workflow, [{ name: "Comment pass", skill: "technical-writer" }]);
      seedHeldTask(workflow, {});
      workflow.store.updateTask(TASK, { status: "in_review" });
      await flushBoards(workflow, JOB);
      await markArtifactReady(workflow, JOB, { close: "ready" });
      await flushBoards(workflow, JOB);
    });

    it("marks the handover with one edit", () =>
      delivered(() => {
        expect(texts(chat, "updateMessage")).toHaveLength(1);
      }));

    it("reads complete with every phase and the humans line checked", () =>
      delivered(() => {
        const last = texts(chat, "updateMessage").at(-1)?.split("\n") ?? [];
        expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · complete*");
        expect(last.slice(-3)).toEqual(["☑ review", "☑ polish", "☑ Ready for Humans"]);
      }));

    describe("and then a follow-up prompt reaches the author", () => {
      const followedUp = scenario(delivered, async (workflow) => {
        workflow.store.updateSandbox(TASK, { session_id: "s2" });
        const author = workflow.store.requireTask(TASK);
        workflow.sockets.push(
          fakeConnection(TASK, workflow.store.requireSandbox(TASK).generation).connection,
        );
        await promptTask(workflow, author, "the checks failed");
        workflow.clock = TEN_AM + 20 * 60_000;
        await flushBoards(workflow, JOB);
      });

      it("has the task working", () =>
        followedUp((workflow) => {
          expect(workflow.store.requireTask(TASK).status).toBe("working");
        }));

      it("posts a new board at the end of the thread and deletes the old one at once", () =>
        followedUp(() => {
          expect(methods(chat)).toEqual([
            "postThreadMessage",
            "updateMessage",
            "postThreadMessage",
            "deleteMessage",
          ]);
        }));

      it("reads working on the new board", () =>
        followedUp(() => {
          const last = texts(chat, "postThreadMessage").at(-1)?.split("\n") ?? [];
          expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · working*");
        }));

      it("opens the follow-ups line ahead of unchecked phases", () =>
        followedUp(() => {
          const last = texts(chat, "postThreadMessage").at(-1)?.split("\n") ?? [];
          expect(last.slice(-4)).toEqual([
            "☐ follow-ups ← working",
            "☐ review",
            "☐ polish",
            "☐ Ready for Humans",
          ]);
        }));

      describe("and then a second prompt reaches the busy author", () => {
        const promptedAgain = scenario(followedUp, async (workflow) => {
          await promptTask(workflow, workflow.store.requireTask(TASK), "and the lint");
        });

        it("moves the board no further", () =>
          promptedAgain(() => {
            expect(methods(chat)).toHaveLength(4);
          }));
      });

      describe("and then the artifact is a draft again and a refiner starts on it", () => {
        const passing = scenario(followedUp, async (workflow) => {
          workflow.store.advanceArtifact(JOB, ["ready"], "drafted");
          await startRefiner(workflow, workflow.store.requireTask(TASK), 0);
          await flushBoards(workflow, JOB);
        });

        it("points the artifact at the refiner", () =>
          passing((workflow) => {
            expect(workflow.store.artifact(JOB)?.refiner_task_id).toEqual(expect.any(String));
          }));

        it("edits the new board", () =>
          passing(() => {
            expect(methods(chat).at(-1)).toBe("updateMessage");
          }));

        it("checks the follow-ups line", () =>
          passing(() => {
            expect(texts(chat, "updateMessage").at(-1)).toContain("☑ follow-ups");
          }));

        it("reads the task's live status in the header", () =>
          passing(() => {
            const last = texts(chat, "updateMessage").at(-1)?.split("\n") ?? [];
            expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · working*");
          }));

        it("opens review and unchecks polish and the humans line", () =>
          passing(() => {
            expect(phaseLines(texts(chat, "updateMessage").at(-1))).toEqual([
              "☐ review ← run 1 · starting",
              "☐ polish",
              "☐ Ready for Humans",
            ]);
          }));

        describe("and then the artifact is handed over again", () => {
          const handedAgain = scenario(passing, async (workflow) => {
            workflow.store.updateTask(TASK, { status: "in_review" });
            await markArtifactReady(workflow, JOB, { close: "ready" });
            await flushBoards(workflow, JOB);
          });

          it("reads complete with the follow-ups, every phase, and the humans line checked", () =>
            handedAgain(() => {
              const last = texts(chat, "updateMessage").at(-1)?.split("\n") ?? [];
              expect(last[0]).toBe("*Fix the login redirect · implement · ENG-1 · complete*");
              expect(last.slice(-4)).toEqual([
                "☑ follow-ups",
                "☑ review",
                "☑ polish",
                "☑ Ready for Humans",
              ]);
            }));
        });
      });
    });
  });

  describe("a stage whose review is off", () => {
    const unreviewed = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      patchStageReviewers(workflow, []);
      seedHeldTask(workflow, {});
      await flushBoards(workflow, JOB);
    });

    it("shows no phase and no humans line", () =>
      unreviewed(() => {
        expect(texts(chat, "postThreadMessage")[0]).not.toContain("☐ review");
        expect(texts(chat, "postThreadMessage")[0]).not.toContain("Ready for Humans");
      }));
  });
});

describe("the board header", () => {
  describe("a task at launch, before the harness reports a todo list", () => {
    const launched = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.patchState({ name: "Fix the login redirect" });
      seedTask(workflow, { issue_key: "ENG-1" });
      await flushBoards(workflow, JOB);
    });

    it("posts the board once", () =>
      launched(() => {
        expect(methods(chat)).toEqual(["postThreadMessage"]);
      }));

    it("names the workflow, the stage and the ticket", () =>
      launched(() => {
        expect(texts(chat, "postThreadMessage")[0]).toContain(
          "*Fix the login redirect · design · ENG-1 · working*",
        );
      }));

    it("says the harness reported no list yet", () =>
      launched(() => {
        expect(texts(chat, "postThreadMessage")[0]).toContain(
          "no todo list reported by the harness yet",
        );
      }));
  });

  describe("a task that claimed no ticket", () => {
    const untracked = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.patchState({ name: "Fix the login redirect" });
      seedBoardTask(workflow, { issue_key: null });
      await flushBoards(workflow, JOB);
    });

    it("drops the ticket field", () =>
      untracked(() => {
        expect(texts(chat, "postThreadMessage")[0]).toContain(
          "*Fix the login redirect · design · working*",
        );
      }));
  });

  describe("a code review task", () => {
    let tracker: FakeTracker;
    const reviewing = scenario(freshRuntime, async (workflow) => {
      tracker = new FakeTracker({ commentId: "comment-9" });
      chat = useChat(workflow, tracker);
      workflow.state.reply_targets = [THREAD, SESSION];
      seedReviewerRun(workflow, { issue_id: "issue-1", issue_key: "ENG-1" });
      await flushBoards(workflow, REVIEW_JOB);
    });

    it("writes the board of its job, which shows the reviewer", () =>
      reviewing((workflow) => {
        expect(workflow.store.boards(REVIEW_JOB).map((board) => board.channel_key)).toEqual([
          CHAT_KEY,
          "tracker:issue-1",
        ]);
        expect(methods(chat)).toEqual(["postThreadMessage"]);
      }));
  });

  describe("a workflow name that holds a link", () => {
    const named = scenario(freshRuntime, async (workflow) => {
      chat = useChat(workflow);
      workflow.state.request = {
        ...workflow.state.request,
        title: "fix https://github.com/acme/app/pull/7 today",
      };
      seedBoardTask(workflow, { issue_key: null });
      await flushBoards(workflow, JOB);
    });

    it("carries no link", () =>
      named(() => {
        expect(texts(chat, "postThreadMessage")[0]).not.toContain("http");
      }));

    it("keeps the rest of the name", () =>
      named(() => {
        expect(texts(chat, "postThreadMessage")[0]).toContain("fix (link removed) today");
      }));
  });
});

describe("the ticket on a board task", () => {
  it("borrows the parent's ticket for a reviewer run", () =>
    freshRuntime((workflow) => {
      const reviewer = seedReviewerRun(workflow, { issue_key: "ENG-1" });
      expect(boardTask(workflow, reviewer)).toMatchObject({
        ticket_key: "ENG-1",
        work: { phase: "review" },
      });
    }));

  it("carries none for a task that claimed no ticket", () =>
    freshRuntime((workflow) => {
      expect(boardTask(workflow, seedTask(workflow)).ticket_key).toBeNull();
    }));
});

describe("a job whose researcher still works", () => {
  const researching = scenario(freshRuntime, async (workflow) => {
    chat = useChat(workflow);
    seedBoardTask(workflow, { role: "researcher", stage: "design" });
    await flushBoards(workflow, JOB);
  });

  it("shows the researcher on the stage of its job", () =>
    researching((workflow) => {
      expect(boardTask(workflow, workflow.store.requireTask(TASK)).work).toEqual({
        stage: "design",
      });
    }));

  it("posts the board of the researcher", () =>
    researching(() => {
      expect(methods(chat)).toEqual(["postThreadMessage"]);
      expect(texts(chat, "postThreadMessage")[0]).toContain("step one");
    }));

  describe("and the board changes", () => {
    const dirty = scenario(researching, async (workflow) => {
      await markBoardDirty(workflow, JOB);
    });

    it("keeps the pending flush on the todo row of the researcher", () =>
      dirty((workflow) => {
        expect(workflow.store.todoRow(TASK)?.flush_schedule).not.toBeNull();
      }));
  });
});

describe("the workflow name on a board task", () => {
  describe("a workflow whose plan named it", () => {
    it("carries the name", () =>
      freshRuntime((workflow) => {
        workflow.patchState({ name: "Flaky checkout test" });
        const task = seedTask(workflow);
        expect(boardTask(workflow, task).workflow_name).toBe("Flaky checkout test");
      }));
  });

  describe("a workflow before its first plan", () => {
    it("carries the request title", () =>
      freshRuntime((workflow) => {
        workflow.state.request = { ...workflow.state.request, title: "fix the flaky test" };
        const task = seedTask(workflow);
        expect(boardTask(workflow, task).workflow_name).toBe("fix the flaky test");
      }));
  });

  describe("a name longer than the label budget", () => {
    it("clips it to the budget", () =>
      freshRuntime((workflow) => {
        workflow.patchState({ name: "n".repeat(100) });
        const task = seedTask(workflow);
        expect(boardTask(workflow, task).workflow_name).toBe("n".repeat(60));
      }));
  });
});

describe("channelKey", () => {
  it("keys a chat board by channel and thread", () => {
    expect(channelKey({ source: "chat", channel: "C1", thread: "1.0" })).toBe(CHAT_KEY);
  });

  it("keys a tracker board by issue", () => {
    expect(channelKey({ source: "tracker", issue_id: "issue-1" })).toBe("tracker:issue-1");
  });
});

describe("hashText", () => {
  it("hashes the same text the same way", () => {
    expect(hashText("a")).toBe(hashText("a"));
  });

  it("hashes different text differently", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("hashes to eight characters", () => {
    expect(hashText("")).toHaveLength(8);
  });
});
