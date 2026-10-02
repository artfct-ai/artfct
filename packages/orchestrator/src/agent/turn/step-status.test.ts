import { describe, expect, it } from "bun:test";
import { stepStatus } from "./step-status";

describe("stepStatus", () => {
  describe("a step that called the same tool twice", () => {
    const calls = [
      { toolName: "get_issue" },
      { toolName: "list_repositories" },
      { toolName: "get_issue" },
    ];

    it("names the step and reads the tool names as words, each once", () => {
      expect(stepStatus(2, calls)).toBe("Step 2: get issue, list repositories");
    });
  });

  describe("a step that called no tool", () => {
    it("gives nothing", () => {
      expect(stepStatus(3, [])).toBeNull();
    });
  });

  describe("a step that called more tools than a title holds", () => {
    const calls = Array.from({ length: 40 }, (_, index) => ({ toolName: `tool_number_${index}` }));

    it("stays inside the Slack title limit", () => {
      expect(stepStatus(1, calls)!.length).toBeLessThanOrEqual(200);
    });
  });
});
