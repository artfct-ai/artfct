import { describe, expect, it } from "bun:test";
import { closeAction } from "./close-policy";

describe("closeAction", () => {
  describe("the code the server sends when it refuses the token", () => {
    it("exits 3", () => {
      expect(closeAction(4001)).toEqual({ kind: "refused", exitCode: 3 });
    });
  });

  describe("a clean close", () => {
    it("exits 0", () => {
      expect(closeAction(1000)).toEqual({ kind: "clean", exitCode: 0 });
    });
  });

  describe("any other code", () => {
    it("retries after an abnormal close", () => {
      expect(closeAction(1006)).toEqual({ kind: "retry" });
    });

    it("retries after a server error", () => {
      expect(closeAction(1011)).toEqual({ kind: "retry" });
    });

    it("retries after an application code it does not know", () => {
      expect(closeAction(4000)).toEqual({ kind: "retry" });
    });
  });
});
