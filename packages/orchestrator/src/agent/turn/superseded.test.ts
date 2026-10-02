import { describe, expect, it } from "bun:test";
import { isSupersededIsolate, supersededToolError, SupersededIsolateError } from "./superseded";

const RESET = "Durable Object reset because its code was updated.";

describe("isSupersededIsolate", () => {
  describe("an error the platform threw", () => {
    it("matches the code update message", () => {
      expect(isSupersededIsolate(new Error(RESET))).toBe(true);
    });

    it("matches the script upgrade message", () => {
      expect(isSupersededIsolate(new Error("This script has been upgraded"))).toBe(true);
    });

    it("matches the storage reset message", () => {
      expect(
        isSupersededIsolate(
          new Error("Internal error in Durable Object storage caused object to be reset."),
        ),
      ).toBe(true);
    });
  });

  describe("a reset down the cause chain", () => {
    it("matches the cause", () => {
      expect(isSupersededIsolate(new Error("wrapped", { cause: new Error(RESET) }))).toBe(true);
    });
  });

  describe("a value that is not an Error", () => {
    it("matches the message as a plain string", () => {
      expect(isSupersededIsolate(RESET)).toBe(true);
    });

    it("matches an object that carries the message", () => {
      expect(isSupersededIsolate({ message: RESET })).toBe(true);
    });
  });

  describe("the error the workflow raises itself", () => {
    it("matches it", () => {
      expect(isSupersededIsolate(new SupersededIsolateError(null))).toBe(true);
    });
  });

  describe("every other error", () => {
    it("ignores an unrelated Error", () => {
      expect(isSupersededIsolate(new Error("model outage"))).toBe(false);
    });

    it("ignores an unrelated message", () => {
      expect(isSupersededIsolate("Durable Object is overloaded")).toBe(false);
    });

    it("ignores a value that carries no message", () => {
      expect(isSupersededIsolate(null)).toBe(false);
      expect(isSupersededIsolate(undefined)).toBe(false);
      expect(isSupersededIsolate(42)).toBe(false);
    });
  });
});

describe("supersededToolError", () => {
  const reset = new Error(RESET);
  const parts = [
    { type: "text" },
    { type: "tool-result" },
    { type: "tool-error", error: new Error("not found") },
    { type: "tool-error", error: reset },
  ];

  describe("a step whose last tool hit the reset", () => {
    it("finds the reset among the parts", () => {
      expect(supersededToolError(parts)).toBe(reset);
    });
  });

  describe("a step with no reset", () => {
    it("finds nothing", () => {
      expect(supersededToolError(parts.slice(0, 3))).toBeNull();
    });
  });
});
