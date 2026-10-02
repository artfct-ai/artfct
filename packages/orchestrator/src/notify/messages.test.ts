import { describe, expect, it } from "bun:test";
import { TAG_TO_START_AGAIN, trackerContent, plainText } from "./messages";

describe("channel messages", () => {
  describe("an artifact that is ready", () => {
    const event = {
      type: "artifact_ready",
      job_id: "wf_x-1",
      artifact_kind: "pull",
      url: "https://github.com/acme/app/pull/1",
      text: "The pull request is ready for you: https://github.com/acme/app/pull/1",
    } as const;

    it("marks the Linear activity as a response on the one line", () => {
      expect(trackerContent(event)).toEqual({
        type: "response",
        body: "The pull request is ready for you: https://github.com/acme/app/pull/1",
      });
    });

    it("says the same one line in plain text", () => {
      expect(plainText(event)).toBe(
        "The pull request is ready for you: https://github.com/acme/app/pull/1",
      );
    });
  });

  describe("progress longer than the Linear parameter cap", () => {
    const content = trackerContent({ type: "progress", task_id: "wf_x.1", text: "x".repeat(300) });

    it("becomes an action for Linear", () => {
      expect(content.type).toBe("action");
    });

    it("cuts the parameter to the cap", () => {
      expect(content.type === "action" && content.parameter.length).toBe(200);
    });
  });

  describe("a finished workflow", () => {
    const event = { type: "done", result: "Merged acme/app#1." } as const;

    it("tells the tracker to tag again for new work", () => {
      expect(trackerContent(event)).toEqual({
        type: "response",
        body: `Merged acme/app#1.\n\n${TAG_TO_START_AGAIN}`,
      });
    });

    it("tells the chat to tag again for new work", () => {
      expect(plainText(event)).toBe(`Done. Merged acme/app#1.\n\n${TAG_TO_START_AGAIN}`);
    });
  });

  describe("a failed workflow", () => {
    const event = { type: "workflow_failed", reason: "The sandbox never started." } as const;

    it("tells the tracker to tag again for new work", () => {
      expect(trackerContent(event)).toEqual({
        type: "error",
        body: `The sandbox never started.\n\n${TAG_TO_START_AGAIN}`,
      });
    });

    it("tells the chat to tag again for new work", () => {
      expect(plainText(event)).toBe(`❌ The sandbox never started.\n\n${TAG_TO_START_AGAIN}`);
    });
  });

  describe("a failed job in a running workflow", () => {
    const event = { type: "failed", job_id: "wf_x-1", reason: "The author stopped." } as const;

    it("says only the reason", () => {
      expect(plainText(event)).toBe("❌ The author stopped.");
    });
  });
});
