import { beforeEach, describe, expect, it } from "bun:test";
import { runUnderDeadline, type Bounded } from "./deadline";

function rejectOnAbort(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

describe("runUnderDeadline", () => {
  describe("work that ends in time", () => {
    it("returns its result", async () => {
      expect(await runUnderDeadline(1000, async () => "ok")).toEqual({
        kind: "done",
        result: "ok",
      });
    });
  });

  describe("work that stops when the deadline aborts it", () => {
    let bounded: Bounded<string>;
    let signal: AbortSignal | undefined;

    beforeEach(async () => {
      bounded = await runUnderDeadline(20, async (given) => {
        signal = given;
        await rejectOnAbort(given);
        return "never";
      });
    });

    it("timed out", () => {
      expect(bounded).toEqual({ kind: "timed_out" });
    });

    it("aborts the signal it gave the work", () => {
      expect(signal?.aborted).toBe(true);
    });
  });

  describe("work that keeps going after the deadline aborts it", () => {
    const steps: string[] = [];
    let bounded: Bounded<string>;

    beforeEach(async () => {
      steps.length = 0;
      bounded = await runUnderDeadline(20, async (signal) => {
        await rejectOnAbort(signal).catch(() => steps.push("aborted"));
        await Promise.resolve();
        steps.push("cleaned up");
        return "late";
      });
      steps.push("returned");
    });

    it("returns only after the work has stopped", () => {
      expect(steps).toEqual(["aborted", "cleaned up", "returned"]);
    });

    it("returns what the work returned", () => {
      expect(bounded).toEqual({ kind: "done", result: "late" });
    });
  });

  describe("work that throws", () => {
    it("surfaces the throw", async () => {
      const run = runUnderDeadline(1000, async () => {
        throw new Error("boom");
      });
      await expect(run).rejects.toThrow("boom");
    });
  });
});
