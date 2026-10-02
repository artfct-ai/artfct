import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";
import { todoPlan } from "./todos";

const todos = [
  { content: "Read the code", status: "completed", priority: "high" },
  { content: "Write the fix", status: "in_progress", priority: "medium" },
  { content: "Run the checks", status: "pending", priority: "low" },
];

function todowrite(rawInput: unknown): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "todowrite",
    kind: "other",
    rawInput,
  };
}

describe("todoPlan", () => {
  describe("a todowrite tool call", () => {
    it("reads the whole list", () => {
      expect(todoPlan(todowrite({ todos }))).toEqual([
        { content: "Read the code", status: "completed", priority: "high" },
        { content: "Write the fix", status: "in_progress", priority: "medium" },
        { content: "Run the checks", status: "pending", priority: "low" },
      ]);
    });

    describe("a list with a cancelled item and words ACP does not know", () => {
      const list = [
        { content: "Old idea", status: "cancelled", priority: "high" },
        { content: "Odd one", status: "blocked", priority: "urgent" },
      ];

      it("drops the cancelled item and maps the unknown words to the ACP defaults", () => {
        expect(todoPlan(todowrite({ todos: list }))).toEqual([
          { content: "Odd one", status: "pending", priority: "medium" },
        ]);
      });
    });
  });

  describe("a running update that repeats the input", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "in_progress",
      rawInput: { todos: todos.slice(0, 1) },
    };

    it("reads the list again", () => {
      expect(todoPlan(update)).toHaveLength(1);
    });
  });

  describe("input that carries no list", () => {
    it("ignores a call whose input holds no todos", () => {
      expect(todoPlan(todowrite({ command: "ls" }))).toBeNull();
    });

    it("ignores todos that are not an array", () => {
      expect(todoPlan(todowrite({ todos: "none" }))).toBeNull();
    });

    it("ignores an item with no text", () => {
      expect(todoPlan(todowrite({ todos: [{ content: 1 }] }))).toBeNull();
    });

    it("ignores a call with no input at all", () => {
      expect(todoPlan(todowrite(undefined))).toBeNull();
    });

    it("ignores an update that is not a tool call", () => {
      expect(
        todoPlan({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      ).toBeNull();
    });
  });
});
