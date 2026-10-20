import { describe, expect, it } from "bun:test";
import { CLAUDE_CODE_STEERING_METHOD, ClaudeCodeSteering } from "./steering";

const steering = new ClaudeCodeSteering();

describe("ClaudeCodeSteering", () => {
  it("asks the adapter to add the text to the running turn and never to start one", () => {
    expect(steering.request("session-1", "Cover the error path too.")).toEqual({
      method: CLAUDE_CODE_STEERING_METHOD,
      params: {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Cover the error path too." }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      },
    });
  });

  it("counts an injected instruction as taken", () => {
    expect(steering.taken({ outcome: "injected" })).toBe(true);
  });

  it("leaves an instruction waiting when the session has no running turn", () => {
    expect(steering.taken({ outcome: "promptRequired", reason: "noRunningTurn" })).toBe(false);
  });

  it("leaves an instruction waiting on an answer it does not know", () => {
    expect(steering.taken(null)).toBe(false);
    expect(steering.taken({})).toBe(false);
  });
});
