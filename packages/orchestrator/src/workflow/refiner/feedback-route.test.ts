import { describe, expect, it } from "bun:test";
import { feedbackRouteFrom } from "./feedback-route";

describe("feedbackRouteFrom", () => {
  it("sends a clear ask of the author to the author", () => {
    expect(feedbackRouteFrom({ for_author: 0.98, beyond_author: 0.06 })).toBe("author");
  });

  it("sends a remark that asks for nothing to nobody", () => {
    expect(feedbackRouteFrom({ for_author: 0.02, beyond_author: 0.1 })).toBe("nobody");
  });

  it("leaves an ask that goes beyond the author to the agent", () => {
    expect(feedbackRouteFrom({ for_author: 0.97, beyond_author: 0.93 })).toBe("agent");
  });

  it("leaves a possible ask beyond the author to the agent", () => {
    expect(feedbackRouteFrom({ for_author: 0.98, beyond_author: 0.34 })).toBe("agent");
  });

  it("leaves an unclear ask of the author to the agent", () => {
    expect(feedbackRouteFrom({ for_author: 0.5, beyond_author: 0.05 })).toBe("agent");
  });
});
