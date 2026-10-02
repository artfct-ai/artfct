import { describe, expect, it } from "bun:test";
import { destinationFor } from "./destination";

describe("destinationFor", () => {
  describe("the start of a task", () => {
    it("goes to the board", () => {
      expect(destinationFor({ type: "started", stage: "design", job_id: "j1" })).toBe("board");
    });
  });

  describe("progress inside a task", () => {
    it("stays internal", () => {
      expect(destinationFor({ type: "progress", task_id: "t1", text: "edit: file" })).toBe(
        "internal",
      );
    });
  });

  describe("an event a person reads now", () => {
    it("sends a question to the channel", () => {
      expect(destinationFor({ type: "question", text: "Which repo?" })).toBe("channel");
    });

    it("sends a ready artifact to the channel", () => {
      expect(
        destinationFor({
          type: "artifact_ready",
          job_id: "j1",
          artifact_kind: "pull",
          url: "u",
          text: "s",
        }),
      ).toBe("channel");
    });

    it("sends a failure to the channel", () => {
      expect(destinationFor({ type: "failed", job_id: "j1", reason: "boom" })).toBe("channel");
    });

    it("sends a finished task to the channel", () => {
      expect(destinationFor({ type: "done", result: "shipped" })).toBe("channel");
    });

    it("sends a status line to the channel", () => {
      expect(destinationFor({ type: "status", text: "Workflow x" })).toBe("channel");
    });

    it("sends an info line to the channel", () => {
      expect(destinationFor({ type: "info", text: "Working in acme/app" })).toBe("channel");
    });
  });
});
