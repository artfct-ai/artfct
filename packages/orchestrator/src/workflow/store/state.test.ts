import { describe, expect, it } from "bun:test";
import { workflowName, type RequestText } from "./state";

const request: RequestText = {
  title: "fix the flaky test",
  text: "fix the flaky test in checkout",
  links: [],
};

describe("workflowName", () => {
  describe("a workflow whose plan named it", () => {
    it("reads as the name", () => {
      expect(workflowName({ name: "Flaky checkout test", request })).toBe("Flaky checkout test");
    });
  });

  describe("a workflow before its first plan", () => {
    it("reads as the request title", () => {
      expect(workflowName({ name: "", request })).toBe("fix the flaky test");
    });
  });

  describe("a workflow stored before names existed", () => {
    it("reads as the request title", () => {
      expect(workflowName({ request })).toBe("fix the flaky test");
    });
  });

  describe("a workflow a bare mention stored before the title was normalized", () => {
    it("reads as the first line of the request", () => {
      const untitled = { ...request, title: "" };
      expect(workflowName({ request: untitled })).toBe("fix the flaky test in checkout");
    });
  });

  describe("a workflow with no name, no title and no text", () => {
    it("never reads as empty, since every reader hands this to a channel", () => {
      expect(workflowName({ request: { title: "", text: "", links: [] } })).toBe("task");
    });
  });
});
