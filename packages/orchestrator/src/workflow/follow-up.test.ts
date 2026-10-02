import { describe, expect, it } from "bun:test";
import { seedPullRequestTask, type FakeRuntime } from "../../test/fake-runtime";
import { freshRuntime } from "../../test/fresh-runtime";
import { scenario } from "../../test/scenario";
import { startFollowUp } from "./follow-up";

const JOB = "wf_x-1";
const CHAT_KEY = "chat:C1:1.0";
const BOARD_THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

function seedIdleAuthor(workflow: FakeRuntime, status: "drafted" | "ready") {
  const task = seedPullRequestTask(workflow, { status: "in_review" }, { status });
  workflow.store.insertBoard(JOB, CHAT_KEY, BOARD_THREAD);
  return task;
}

describe("startFollowUp", () => {
  describe("an idle author whose artifact the humans hold", () => {
    let started = false;
    const followedUp = scenario(freshRuntime, (workflow) => {
      started = startFollowUp(workflow, seedIdleAuthor(workflow, "ready"));
    });

    it("starts a follow-up", () =>
      followedUp(() => {
        expect(started).toBe(true);
      }));

    it("moves the board to the end of its thread on the next flush", () =>
      followedUp((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(1);
      }));
  });

  describe("an idle author whose artifact the refiners hold", () => {
    const drafted = scenario(freshRuntime, (workflow) => {
      startFollowUp(workflow, seedIdleAuthor(workflow, "drafted"));
    });

    it("leaves the board where it is", () =>
      drafted((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(0);
      }));
  });

  describe("an author with a prompt waiting", () => {
    const queued = scenario(freshRuntime, (workflow) => {
      const task = seedIdleAuthor(workflow, "ready");
      workflow.store.enqueuePrompt(task.task_id, "fix the lint");
      startFollowUp(workflow, task);
    });

    it("leaves the board where it is", () =>
      queued((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(0);
      }));
  });

  describe("an author whose turn is running", () => {
    const working = scenario(freshRuntime, (workflow) => {
      const task = seedPullRequestTask(workflow, { status: "working" }, { status: "ready" });
      workflow.store.insertBoard(JOB, CHAT_KEY, BOARD_THREAD);
      startFollowUp(workflow, task);
    });

    it("leaves the board where it is", () =>
      working((workflow) => {
        expect(workflow.store.board(JOB, CHAT_KEY)?.relocate).toBe(0);
      }));
  });
});
