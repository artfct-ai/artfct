import { describe, expect, it } from "bun:test";
import { FEED_BODY_CHARS, renderFeed, toolVerb } from "./render";
import type { FeedItem } from "./types";

const THOUGHT: FeedItem = { seq: 1, kind: "thought", text: "Look at login." };
const READ: FeedItem = {
  seq: 2,
  kind: "tool",
  title: "src/login.ts",
  tool_kind: "read",
  failed: false,
};
const FAILED_RUN: FeedItem = {
  seq: 3,
  kind: "tool",
  title: "bun test",
  tool_kind: "execute",
  failed: true,
};
const MESSAGE: FeedItem = { seq: 4, kind: "message", text: "Opened PR #12." };
const ERROR: FeedItem = { seq: 5, kind: "error", text: "The turn ended." };

describe("renderFeed", () => {
  it("posts nothing for no items", () => {
    expect(renderFeed([], false)).toEqual([]);
    expect(renderFeed([], true)).toEqual([]);
  });

  it("posts one thought as a thought", () => {
    expect(renderFeed([THOUGHT], false)).toEqual([
      { content: { type: "thought", body: "Look at login." }, seqs: [1] },
    ]);
  });

  it("posts one tool call as an action", () => {
    expect(renderFeed([READ], false)).toEqual([
      {
        content: { type: "action", action: "Read", parameter: "src/login.ts" },
        seqs: [2],
      },
    ]);
  });

  it("marks a failed tool call in its result", () => {
    expect(renderFeed([FAILED_RUN], false)[0]?.content).toEqual({
      type: "action",
      action: "Run",
      parameter: "bun test",
      result: "failed",
    });
  });

  it("posts a message before the end of the turn as a thought", () => {
    expect(renderFeed([MESSAGE], false)[0]?.content).toEqual({
      type: "thought",
      body: "Opened PR #12.",
    });
  });

  it("joins several items into one thought", () => {
    expect(renderFeed([THOUGHT, READ, FAILED_RUN], false)).toEqual([
      {
        content: {
          type: "thought",
          body: "Look at login.\n\n- Read: src/login.ts\n\n- Run: bun test (failed)",
        },
        seqs: [1, 2, 3],
      },
    ]);
  });

  it("closes with the last message as the reply, after one activity for the rest", () => {
    expect(renderFeed([THOUGHT, READ, MESSAGE], true)).toEqual([
      {
        content: { type: "thought", body: "Look at login.\n\n- Read: src/login.ts" },
        seqs: [1, 2],
      },
      { content: { type: "response", body: "Opened PR #12." }, seqs: [4] },
    ]);
  });

  it("closes with an error item as the error", () => {
    expect(renderFeed([ERROR], true)).toEqual([
      { content: { type: "error", body: "The turn ended." }, seqs: [5] },
    ]);
  });

  it("cuts a long body to the limit", () => {
    const long: FeedItem = { ...THOUGHT, text: "x".repeat(FEED_BODY_CHARS + 50) };
    const content = renderFeed([long], false)[0]?.content;
    expect(content?.type === "thought" && content.body.length).toBe(FEED_BODY_CHARS);
  });
});

describe("toolVerb", () => {
  it("names a tool call without a kind as a tool", () => {
    expect(toolVerb(null)).toBe("Tool");
  });
});
