import { describe, expect, it } from "bun:test";
import { classifyPrompt, isStatus } from "./classify";

describe("classify", () => {
  describe("isStatus", () => {
    describe("text that is only the question", () => {
      it("recognizes a status question", () => {
        expect(isStatus("status?")).toBe(true);
      });

      it("recognizes a question wrapped in spaces", () => {
        expect(isStatus("  progress ")).toBe(true);
      });
    });

    describe("a question inside a longer sentence", () => {
      it("does not recognize it", () => {
        expect(isStatus("what is the status of the login fix")).toBe(false);
      });
    });
  });

  describe("classifyPrompt", () => {
    it("answers status for a bare status question", () => {
      expect(classifyPrompt("status")).toBe("status");
    });

    it("hands an approval to the agent", () => {
      expect(classifyPrompt("lgtm")).toBe("prompt");
    });

    it("hands a cancel word to the agent", () => {
      expect(classifyPrompt("cancel")).toBe("prompt");
    });
  });
});
