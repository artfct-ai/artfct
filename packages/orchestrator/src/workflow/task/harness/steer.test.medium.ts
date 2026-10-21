import type { SessionNotification } from "@agentclientprotocol/sdk";
import { jsonRpcNotification, jsonRpcResponse } from "@artfct-ai/acp/jsonrpc";
import { AgentMethods, ClientMethods } from "@artfct-ai/acp/methods";
import { ClaudeCodeSteering } from "@artfct-ai/adapters/harness/claude-code/steering";
import { FakeHarness } from "@artfct-ai/adapters/test/fake-harness";
import { describe, expect, it } from "vitest";
import { freshDurableRuntime } from "../../../../test/durable-runtime";
import {
  fakeConnection,
  seedTask,
  type FakeRuntime,
  type FakeSocket,
} from "../../../../test/fake-runtime";
import { scenario, type Scenario } from "../../../../test/scenario";
import { onBridgeMessage } from "./bridge";
import { instructTask } from "./prompt-queue";

const TASK = "wf_x.1";
const INSTRUCTION = "Use the staging database.";

type Frame = { id?: number; method?: string; params?: unknown };

type Turn = { workflow: FakeRuntime; socket: FakeSocket; promptId: number };

function framesOf(socket: FakeSocket): Frame[] {
  return socket.sent.map((frame) => JSON.parse(frame) as Frame);
}

function lastFrame(socket: FakeSocket): Frame {
  const frames = framesOf(socket);
  return frames[frames.length - 1]!;
}

function runningTurn(steering: ClaudeCodeSteering | null): Scenario<Turn> {
  return (run) =>
    freshDurableRuntime(async (workflow) => {
      workflow.harnessInstance = new FakeHarness({ steering });
      seedTask(workflow, {}, { session_id: "s1", prompt_in_flight: 1 });
      const promptId = workflow.store.insertRpc(TASK, AgentMethods.sessionPrompt, "prompt");
      const socket = fakeConnection(TASK, 1);
      workflow.sockets.push(socket.connection);
      await run({ workflow, socket, promptId });
    });
}

function answer(turn: Turn, id: number, result: unknown): Promise<void> {
  const frame = JSON.stringify(jsonRpcResponse(id, result));
  return onBridgeMessage(turn.workflow, turn.socket.connection, frame);
}

const instructed = scenario(runningTurn(new ClaudeCodeSteering()), ({ workflow }) =>
  instructTask(workflow, workflow.store.requireTask(TASK), INSTRUCTION),
);

function steerIdOf(turn: Turn): number {
  return lastFrame(turn.socket).id!;
}

function reportToolCall(turn: Turn): Promise<void> {
  const update: SessionNotification = {
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Read the schema" },
  };
  const frame = JSON.stringify(jsonRpcNotification(ClientMethods.sessionUpdate, update));
  return onBridgeMessage(turn.workflow, turn.socket.connection, frame);
}

describe("an instruction to an author whose harness steers, while its turn runs", () => {
  it("sends the steering request with the instruction into the running turn", () =>
    instructed(({ socket }) => {
      expect(lastFrame(socket)).toMatchObject({
        method: "_session/steering",
        params: {
          sessionId: "s1",
          prompt: [{ type: "text", text: INSTRUCTION }],
          _meta: { steering: { idleBehavior: "promptRequired" } },
        },
      });
    }));

  it("marks the steer out, so the instruction does not wait for the next prompt", () =>
    instructed((turn) => {
      expect(turn.workflow.store.steers()).toEqual([
        expect.objectContaining({ rpc_id: steerIdOf(turn), status: "out" }),
      ]);
      expect(turn.workflow.store.peekPrompt(TASK)).toBeNull();
    }));

  describe("that the turn takes", () => {
    const taken = scenario(instructed, (turn) =>
      answer(turn, steerIdOf(turn), { outcome: "injected" }),
    );

    it("holds the instruction as taken", () =>
      taken(({ workflow }) => {
        expect(workflow.store.steers().map((steer) => steer.status)).toEqual(["taken"]);
      }));

    it("drops it once the turn ends on its own", () =>
      taken(async (turn) => {
        await answer(turn, turn.promptId, { stopReason: "end_turn" });
        expect(turn.workflow.store.queue()).toEqual([]);
        expect(turn.workflow.store.steers()).toEqual([]);
      }));

    it("sends it again as the next prompt when the turn is cancelled", () =>
      taken(async (turn) => {
        await answer(turn, turn.promptId, { stopReason: "cancelled" });
        expect(lastFrame(turn.socket)).toMatchObject({
          method: AgentMethods.sessionPrompt,
          params: { prompt: [{ type: "text", text: INSTRUCTION }] },
        });
      }));
  });

  describe("that the harness declines because its turn has not started", () => {
    const declined = scenario(instructed, (turn) =>
      answer(turn, steerIdOf(turn), { outcome: "promptRequired", reason: "noRunningTurn" }),
    );

    it("lets the instruction wait again", () =>
      declined(({ workflow }) => {
        expect(workflow.store.steers()).toEqual([]);
        expect(workflow.store.peekPrompt(TASK)?.text).toBe(INSTRUCTION);
      }));

    it("steers it again when the turn reports progress", () =>
      declined(async (turn) => {
        const declinedSteer = steerIdOf(turn);
        await reportToolCall(turn);
        expect(lastFrame(turn.socket)).toMatchObject({
          method: "_session/steering",
          params: { prompt: [{ type: "text", text: INSTRUCTION }] },
        });
        expect(steerIdOf(turn)).not.toBe(declinedSteer);
        expect(turn.workflow.store.steers().map((steer) => steer.status)).toEqual(["out"]);
      }));

    it("sends it as the next prompt when the turn ends without progress", () =>
      declined(async (turn) => {
        await answer(turn, turn.promptId, { stopReason: "end_turn" });
        expect(lastFrame(turn.socket)).toMatchObject({
          method: AgentMethods.sessionPrompt,
          params: { prompt: [{ type: "text", text: INSTRUCTION }] },
        });
        expect(turn.workflow.store.steers().map((steer) => steer.status)).toEqual(["taken"]);
      }));
  });

  describe("that reaches the harness after its turn ended", () => {
    const late = scenario(instructed, async (turn) => {
      const steer = steerIdOf(turn);
      await answer(turn, turn.promptId, { stopReason: "end_turn" });
      await answer(turn, steer, { outcome: "promptRequired", reason: "noRunningTurn" });
    });

    it("keeps the instruction that the next prompt carried", () =>
      late(({ workflow, socket }) => {
        expect(lastFrame(socket)).toMatchObject({
          method: AgentMethods.sessionPrompt,
          params: { prompt: [{ type: "text", text: INSTRUCTION }] },
        });
        expect(workflow.store.steers().map((steer) => steer.status)).toEqual(["taken"]);
      }));
  });
});

describe("an instruction to an author whose harness cannot steer, while its turn runs", () => {
  const queued = scenario(runningTurn(null), ({ workflow }) =>
    instructTask(workflow, workflow.store.requireTask(TASK), INSTRUCTION),
  );

  it("waits in the queue for the turn end", () =>
    queued(({ workflow, socket }) => {
      expect(socket.sent).toEqual([]);
      expect(workflow.store.peekPrompt(TASK)?.text).toBe(INSTRUCTION);
    }));
});
