import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { describe, expect, it } from "bun:test";
import type { TaskEvent } from "../workflow/task/events";
import { hasChatThread, recipientsOf, type Audience } from "./recipients";

const THREAD: ReplyTarget = { source: "chat", channel: "C1", thread: "1.0" };
const STARTING: ReplyTarget = { source: "tracker", session_id: "s-start", issue_id: "ENG-1" };
const JOB_SESSION: ReplyTarget = { source: "tracker", session_id: "s-job", issue_id: "ENG-2" };
const PAGE: ReplyTarget = { source: "documents", page_id: "page-1" };

const INFO: TaskEvent = { type: "info", text: "Working on it." };
const QUESTION: TaskEvent = { type: "question", text: "Which repo?" };
const FAILED: TaskEvent = { type: "workflow_failed", reason: "broke" };

function audience(origin: ReplyTarget | null, replyTargets: ReplyTarget[]): Audience {
  return { origin, reply_targets: replyTargets };
}

describe("hasChatThread", () => {
  it("is true with a chat thread among the reply targets", () => {
    expect(hasChatThread(audience(STARTING, [STARTING, THREAD]))).toBe(true);
  });

  it("is false with only tracker sessions", () => {
    expect(hasChatThread(audience(STARTING, [STARTING, JOB_SESSION]))).toBe(false);
  });
});

describe("recipientsOf", () => {
  describe("a workflow with a chat thread and sessions", () => {
    const withChat = audience(STARTING, [STARTING, THREAD, JOB_SESSION, PAGE]);

    it("sends an ask to the chat thread and the page, and to no session", () => {
      expect(recipientsOf(withChat, QUESTION, { answering: [] })).toEqual([THREAD, PAGE]);
    });

    it("sends the answer to a person in a session to the chat thread", () => {
      expect(recipientsOf(withChat, INFO, { answering: [JOB_SESSION] })).toEqual([THREAD, PAGE]);
    });

    it("sends a reply to a session to the chat threads", () => {
      expect(recipientsOf(withChat, INFO, { reply_to: JOB_SESSION })).toEqual([THREAD]);
    });

    it("sends a reply to the chat thread to that thread", () => {
      expect(recipientsOf(withChat, INFO, { reply_to: THREAD })).toEqual([THREAD]);
    });
  });

  describe("a workflow that started from a session and has no chat thread", () => {
    const linearOnly = audience(STARTING, [STARTING, JOB_SESSION]);

    it("sends an ask to the starting session", () => {
      expect(recipientsOf(linearOnly, QUESTION, { answering: [] })).toEqual([STARTING]);
    });

    it("sends a failure notice to the starting session", () => {
      expect(recipientsOf(linearOnly, FAILED, { answering: [] })).toEqual([STARTING]);
    });

    it("keeps other posts out of every session", () => {
      expect(recipientsOf(linearOnly, INFO, { answering: [] })).toEqual([]);
    });

    it("sends an answer to the session the person wrote in", () => {
      expect(recipientsOf(linearOnly, INFO, { answering: [JOB_SESSION] })).toEqual([JOB_SESSION]);
    });

    it("sends an ask that answers the starting session there once", () => {
      expect(recipientsOf(linearOnly, QUESTION, { answering: [STARTING] })).toEqual([STARTING]);
    });

    it("sends a reply to a session to that session", () => {
      expect(recipientsOf(linearOnly, INFO, { reply_to: JOB_SESSION })).toEqual([JOB_SESSION]);
    });
  });

  describe("a workflow that started from chat and has no session", () => {
    it("sends a post to the chat thread", () => {
      expect(recipientsOf(audience(THREAD, [THREAD]), INFO, { answering: [] })).toEqual([THREAD]);
    });
  });
});
