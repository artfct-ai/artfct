import type {
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  errorOf,
  isRequest,
  isResponse,
  jsonRpcRequest,
  jsonRpcResponse,
  resultOf,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "@artfct-ai/acp/jsonrpc";
import { AgentMethods, ClientMethods } from "@artfct-ai/acp/methods";
import { beforeEach, describe, expect, it } from "bun:test";
import { MockHarness } from "./mock-harness";
import { docUrlForStage } from "./mock-harness-turn";

const env = { ARTFCT_MOCK_REPO_URL: "https://github.com/acme/app", ARTFCT_MOCK_PR_NUMBER: "7" };

function startMock(extraEnv: Record<string, string> = {}) {
  const sent: JsonRpcMessage[] = [];
  const mock = new MockHarness(
    (message) => {
      sent.push(message);
      if (!isRequest(message) || message.method !== ClientMethods.sessionRequestPermission) return;
      const answer: RequestPermissionResponse = {
        outcome: { outcome: "selected", optionId: "allow" },
      };
      void mock.send(jsonRpcResponse(message.id, answer));
    },
    { ...env, ...extraEnv },
  );
  return { mock, sent };
}

async function firstReply(mock: MockHarness, sent: JsonRpcMessage[]): Promise<string> {
  await mock.send(jsonRpcRequest(1, AgentMethods.initialize, { protocolVersion: 1 }));
  const newSession: NewSessionRequest = { cwd: "/workspace", mcpServers: [] };
  await mock.send(jsonRpcRequest(2, AgentMethods.sessionNew, newSession));
  const { sessionId } = resultOf(responseTo(sent, 2)) as NewSessionResponse;
  const prompt: PromptRequest = { sessionId, prompt: [{ type: "text", text: "do it" }] };
  await mock.send(jsonRpcRequest(3, AgentMethods.sessionPrompt, prompt));
  const reply = updates(sent)
    .map((update) => update.update)
    .at(-1);
  return reply?.sessionUpdate === "agent_message_chunk" && reply.content.type === "text"
    ? reply.content.text
    : "";
}

function responseTo(sent: JsonRpcMessage[], id: number): JsonRpcResponse {
  for (const message of sent) {
    if (isResponse(message) && message.id === id) return message;
  }
  throw new Error(`no response to ${id}`);
}

function updates(sent: JsonRpcMessage[]): SessionNotification[] {
  return sent
    .filter((message) => "method" in message && message.method === ClientMethods.sessionUpdate)
    .map((message) => (message as { params: SessionNotification }).params);
}

function permissionRequests(sent: JsonRpcMessage[]): JsonRpcMessage[] {
  return sent.filter(
    (message) => isRequest(message) && message.method === ClientMethods.sessionRequestPermission,
  );
}

describe("MockHarness", () => {
  describe("a harness that has initialized", () => {
    let mock: MockHarness;
    let sent: JsonRpcMessage[];

    beforeEach(async () => {
      ({ mock, sent } = startMock());
      await mock.send(jsonRpcRequest(1, AgentMethods.initialize, { protocolVersion: 1 }));
    });

    it("answers with the protocol version", () => {
      expect(resultOf(responseTo(sent, 1))).toMatchObject({ protocolVersion: 1 });
    });

    describe("with a new session", () => {
      let sessionId: string;

      beforeEach(async () => {
        const newSession: NewSessionRequest = { cwd: "/workspace", mcpServers: [] };
        await mock.send(jsonRpcRequest(2, AgentMethods.sessionNew, newSession));
        ({ sessionId } = resultOf(responseTo(sent, 2)) as NewSessionResponse);
      });

      it("marks the session id as a mock one", () => {
        expect(sessionId).toMatch(/^mock-/);
      });

      describe("after one prompt", () => {
        beforeEach(async () => {
          const prompt: PromptRequest = {
            sessionId,
            prompt: [{ type: "text", text: "add a feature" }],
          };
          await mock.send(jsonRpcRequest(3, AgentMethods.sessionPrompt, prompt));
        });

        it("ends the turn", () => {
          expect(resultOf(responseTo(sent, 3))).toEqual({ stopReason: "end_turn" });
        });

        it("asks the client for one permission", () => {
          expect(permissionRequests(sent)).toHaveLength(1);
        });

        it("names the tool call it wants to run", () => {
          expect(permissionRequests(sent)[0]).toMatchObject({
            params: { sessionId, toolCall: { title: "Edit src/index.ts" } },
          });
        });

        it("sends the updates of a whole turn in order", () => {
          expect(updates(sent).map((update) => update.update.sessionUpdate)).toEqual([
            "agent_thought_chunk",
            "plan",
            "tool_call",
            "tool_call_update",
            "plan",
            "agent_message_chunk",
          ]);
        });

        it("reports the PR in the last message chunk", () => {
          const reply = updates(sent)
            .map((update) => update.update)
            .at(-1);
          expect(reply?.sessionUpdate === "agent_message_chunk" && reply.content).toMatchObject({
            type: "text",
            text: expect.stringContaining("https://github.com/acme/app/pull/7"),
          });
        });
      });
    });
  });

  describe("a turn on a document stage", () => {
    let reply: string;

    beforeEach(async () => {
      const { mock, sent } = startMock({ ARTFCT_STAGE: "design" });
      reply = await firstReply(mock, sent);
    });

    it("reports a Notion page", () => {
      expect(reply).toContain(docUrlForStage("design"));
    });

    it("reports no PR", () => {
      expect(reply).not.toContain("github.com");
    });
  });

  describe("a turn on the PR stage", () => {
    it("reports the PR", async () => {
      const { mock, sent } = startMock({ ARTFCT_STAGE: "implement" });
      expect(await firstReply(mock, sent)).toContain("https://github.com/acme/app/pull/7");
    });
  });

  describe("a prompt for a session that does not exist", () => {
    it("fails with unknown session", async () => {
      const { mock, sent } = startMock();
      const prompt: PromptRequest = { sessionId: "nope", prompt: [] };
      await mock.send(jsonRpcRequest(9, AgentMethods.sessionPrompt, prompt));
      expect(errorOf(responseTo(sent, 9))).toMatchObject({ message: "unknown session" });
    });
  });
});
