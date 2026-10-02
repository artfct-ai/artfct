import { describe, expect, it } from "bun:test";
import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  errorOf,
  jsonRpcErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  jsonRpcNotification,
  parseMessage,
  jsonRpcRequest,
  jsonRpcResponse,
  resultOf,
} from "./jsonrpc";
import {
  chooseAllowOption,
  planEntries,
  summarizeUpdate,
  toolActivity,
  updateText,
} from "./updates";

describe("parseMessage", () => {
  describe("a well formed frame", () => {
    it("classifies a request", () => {
      expect(isRequest(parseMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}')!)).toBe(true);
    });

    it("classifies a response", () => {
      expect(isResponse(parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}')!)).toBe(true);
    });

    it("classifies a notification", () => {
      expect(isNotification(parseMessage('{"jsonrpc":"2.0","method":"session/update"}')!)).toBe(
        true,
      );
    });

    it("accepts a null id, as the SDK does", () => {
      const failure = parseMessage(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}',
      );
      expect(failure && isResponse(failure)).toBe(true);
    });
  });

  describe("a frame that is not JSON-RPC", () => {
    it("rejects text that is not JSON", () => {
      expect(parseMessage("nope")).toBeNull();
    });

    it("rejects a frame with neither method nor result", () => {
      expect(parseMessage('{"jsonrpc":"2.0","id":1}')).toBeNull();
    });

    it("rejects another protocol version", () => {
      expect(parseMessage('{"jsonrpc":"1.0","method":"x"}')).toBeNull();
    });
  });
});

describe("reading a response", () => {
  describe("a success response", () => {
    const message = jsonRpcResponse(1, { ok: true });

    it("carries the result", () => {
      expect(resultOf(message)).toEqual({ ok: true });
    });

    it("carries no error", () => {
      expect(errorOf(message)).toBeUndefined();
    });
  });

  describe("an error response", () => {
    const message = jsonRpcErrorResponse(2, -32601, "nope");

    it("carries no result", () => {
      expect(resultOf(message)).toBeUndefined();
    });

    it("carries the code and the message", () => {
      expect(errorOf(message)).toEqual({ code: -32601, message: "nope" });
    });
  });
});

describe("message builders", () => {
  describe("request", () => {
    const message = jsonRpcRequest(7, "session/prompt", { sessionId: "s" });

    it("carries the id, method and params", () => {
      expect(message).toEqual({
        jsonrpc: "2.0",
        id: 7,
        method: "session/prompt",
        params: { sessionId: "s" },
      });
    });

    it("reads back as a request", () => {
      expect(isRequest(message)).toBe(true);
    });

    it("does not read as a response", () => {
      expect(isResponse(message)).toBe(false);
    });
  });

  describe("notification", () => {
    const message = jsonRpcNotification("session/update", { text: "x" });

    it("carries the method and params with no id", () => {
      expect(message).toEqual({ jsonrpc: "2.0", method: "session/update", params: { text: "x" } });
    });

    it("reads back as a notification", () => {
      expect(isNotification(message)).toBe(true);
    });

    it("does not read as a request", () => {
      expect(isRequest(message)).toBe(false);
    });
  });

  describe("response", () => {
    const message = jsonRpcResponse("abc", null);

    it("carries the id and the result", () => {
      expect(message).toEqual({ jsonrpc: "2.0", id: "abc", result: null });
    });

    it("reads back as a response", () => {
      expect(isResponse(message)).toBe(true);
    });
  });

  describe("errorResponse", () => {
    const message = jsonRpcErrorResponse(3, -32603, "boom");

    it("carries the id, code and message", () => {
      expect(message).toEqual({
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32603, message: "boom" },
      });
    });

    it("does not read as a notification", () => {
      expect(isNotification(message)).toBe(false);
    });
  });

  describe("a built message on the wire", () => {
    it("round trips through parseMessage", () => {
      const message = jsonRpcRequest(1, "initialize", { protocolVersion: 1 });
      expect(parseMessage(JSON.stringify(message))).toEqual(message);
    });
  });
});

describe("chooseAllowOption", () => {
  describe("options that include allow_always", () => {
    it("prefers allow_always", () => {
      expect(
        chooseAllowOption([
          { optionId: "r", name: "Reject", kind: "reject_once" },
          { optionId: "a1", name: "Allow", kind: "allow_once" },
          { optionId: "aa", name: "Always", kind: "allow_always" },
        ]),
      ).toBe("aa");
    });
  });

  describe("options that allow only once", () => {
    it("falls back to allow_once", () => {
      expect(
        chooseAllowOption([
          { optionId: "r", name: "Reject", kind: "reject_once" },
          { optionId: "a1", name: "Allow", kind: "allow_once" },
        ]),
      ).toBe("a1");
    });
  });

  describe("options that never allow", () => {
    it("takes the first option", () => {
      expect(
        chooseAllowOption([
          { optionId: "r1", name: "Reject", kind: "reject_once" },
          { optionId: "r2", name: "Reject always", kind: "reject_always" },
        ]),
      ).toBe("r1");
    });
  });

  describe("an empty list", () => {
    it("has nothing to choose", () => {
      expect(chooseAllowOption([])).toBeNull();
    });
  });
});

describe("updateText", () => {
  describe("an agent message chunk", () => {
    it("returns the text", () => {
      const update: SessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      };
      expect(updateText(update)).toBe("hello");
    });

    it("returns null for content that is not text", () => {
      const update: SessionUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png" },
      };
      expect(updateText(update)).toBeNull();
    });
  });

  describe("any other update kind", () => {
    it("returns null", () => {
      const update: SessionUpdate = {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      };
      expect(updateText(update)).toBeNull();
    });
  });
});

describe("summarizeUpdate", () => {
  describe("a tool call", () => {
    it("names it by kind and title", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "git push",
          kind: "execute",
        }),
      ).toBe("execute: git push");
    });

    it("says tool when the call has no kind", () => {
      expect(
        summarizeUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "git push" }),
      ).toBe("tool: git push");
    });
  });

  describe("a tool call that failed", () => {
    it("names it by title", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "failed",
          title: "git push",
        }),
      ).toBe("tool failed: git push");
    });

    it("falls back to the call id", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "failed",
        }),
      ).toBe("tool failed: tc-1");
    });
  });

  describe("a tool call update that did not fail", () => {
    it("stays quiet", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        }),
      ).toBeNull();
    });
  });

  describe("a plan update", () => {
    it("stays quiet and leaves the plan to planEntries", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "plan",
          entries: [{ content: "read code", priority: "high", status: "completed" }],
        }),
      ).toBeNull();
    });
  });

  describe("a message chunk", () => {
    it("stays quiet", () => {
      expect(
        summarizeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      ).toBeNull();
    });
  });
});

describe("planEntries", () => {
  describe("a plan update", () => {
    it("returns its entries", () => {
      const entries: PlanEntry[] = [
        { content: "read code", priority: "high", status: "completed" },
        { content: "write fix", priority: "medium", status: "in_progress" },
      ];
      expect(planEntries({ sessionUpdate: "plan", entries })).toEqual(entries);
    });
  });

  describe("any other update", () => {
    it("returns null", () => {
      expect(
        planEntries({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } }),
      ).toBeNull();
    });
  });
});

describe("toolActivity", () => {
  describe("a tool call", () => {
    it("counts a call with its title", () => {
      expect(
        toolActivity({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "git push" }),
      ).toEqual({ kind: "call", title: "git push" });
    });
  });

  describe("a tool call that failed", () => {
    it("counts a failure by the call id", () => {
      expect(
        toolActivity({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "failed" }),
      ).toEqual({ kind: "failed", title: "tc-1" });
    });
  });

  describe("a tool call that completed", () => {
    it("counts nothing", () => {
      expect(
        toolActivity({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        }),
      ).toBeNull();
    });
  });
});
