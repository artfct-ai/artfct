import { describe, expect, it } from "bun:test";
import { rulingForRejectProbability } from "./ruling";

describe("rulingForRejectProbability", () => {
  it("reads a probability at the floor as rejected", () => {
    expect(rulingForRejectProbability(0.7)).toBe("rejected");
  });

  it("reads a probability at the ceiling as approved", () => {
    expect(rulingForRejectProbability(0.3)).toBe("approved");
  });

  it("gives no ruling between the two", () => {
    expect(rulingForRejectProbability(0.31)).toBeNull();
    expect(rulingForRejectProbability(0.69)).toBeNull();
  });
});
