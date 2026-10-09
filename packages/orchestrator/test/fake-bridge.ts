import type {
  InitializeResponse,
  NewSessionResponse,
  PlanEntry,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  isNotification,
  isRequest,
  jsonRpcErrorResponse,
  jsonRpcNotification,
  jsonRpcResponse,
  parseMessage,
  type JsonRpcId,
  type JsonRpcResponse,
} from "@artfct-ai/acp/jsonrpc";
import {
  AgentMethods,
  BridgeMethods,
  ClientMethods,
  type BridgeHelloParams,
} from "@artfct-ai/acp/methods";
import { onBridgeMessage } from "../src/workflow/task/harness/bridge";
import type { TaskRow } from "../src/workflow/store/tasks";
import { fakeConnection, type FakeRuntime, type FakeSocket } from "./fake-runtime";

const INTERNAL_ERROR = -32603;

/** One request the workflow sent. The store reuses ids, so the frame number tells two apart. */
type SentRequest = { frame: number; id: JsonRpcId };

/**
 * The sandbox end of one task's bridge socket. Every frame goes through `onBridgeMessage`, the
 * way a real bridge reaches the workflow.
 */
export class FakeBridge {
  private readonly answeredFrames = new Set<number>();

  private constructor(
    private readonly workflow: FakeRuntime,
    private readonly socket: FakeSocket,
    readonly taskId: string,
    private readonly sessionId: string,
  ) {}

  /** Dial in for a provisioning task and answer the handshake, so its first prompt is sent. */
  static async connect(workflow: FakeRuntime, task: TaskRow): Promise<FakeBridge> {
    const sandbox = workflow.store.requireSandbox(task.task_id);
    const socket = fakeConnection(task.task_id, sandbox.generation);
    workflow.sockets.push(socket.connection);
    const sessionId = `session-${task.task_id}-${sandbox.generation}`;
    const bridge = new FakeBridge(workflow, socket, task.task_id, sessionId);
    const hello: BridgeHelloParams = {
      fresh: true,
      harness: sandbox.harness,
      generation: sandbox.generation,
    };
    await bridge.deliver(jsonRpcNotification(BridgeMethods.hello, hello));
    const initialized: InitializeResponse = { protocolVersion: 1 };
    await bridge.answer(AgentMethods.initialize, initialized);
    const session: NewSessionResponse = { sessionId };
    await bridge.answer(AgentMethods.sessionNew, session);
    return bridge;
  }

  /** True until the workflow closes the socket. */
  get open(): boolean {
    return this.socket.closes.length === 0;
  }

  /** How many prompts the workflow sent over this socket. */
  get promptsSent(): number {
    return this.requests(AgentMethods.sessionPrompt).length;
  }

  /** True while a prompt the workflow sent has no turn end yet. */
  get turnRunning(): boolean {
    return this.unanswered(AgentMethods.sessionPrompt) !== null;
  }

  /** The text of every prompt the workflow sent over this socket. */
  get promptTexts(): string[] {
    return this.socket.sent.flatMap((text) => {
      const message = parseMessage(text);
      if (!message || !isRequest(message) || message.method !== AgentMethods.sessionPrompt) {
        return [];
      }
      const { prompt } = message.params as PromptRequest;
      return prompt.flatMap((block) => (block.type === "text" ? [block.text] : []));
    });
  }

  /** How many cancels the workflow sent over this socket. */
  get cancelsSent(): number {
    return this.cancelFrames().length;
  }

  /** True when the workflow sent a cancel after the prompt whose turn runs. The turn then ends cancelled. */
  get cancelRequested(): boolean {
    const running = this.unanswered(AgentMethods.sessionPrompt);
    return running !== null && this.cancelFrames().some((frame) => frame > running.frame);
  }

  /** The harness streams turn text. */
  say(text: string): Promise<void> {
    return this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  /** The harness reports its todo list. */
  reportTodos(entries: PlanEntry[]): Promise<void> {
    return this.update({ sessionUpdate: "plan", entries });
  }

  /** The running turn ends. False when no turn runs. */
  endTurn(stopReason: StopReason): Promise<boolean> {
    const ended: PromptResponse = { stopReason };
    return this.answer(AgentMethods.sessionPrompt, ended);
  }

  /** The sandbox goes away and takes the socket with it. */
  drop(): void {
    this.socket.connection.close(1006, "the sandbox went away");
  }

  /** The harness answers the running prompt with an error. False when no turn runs. */
  failPrompt(message: string): Promise<boolean> {
    return this.respond(AgentMethods.sessionPrompt, (id) =>
      jsonRpcErrorResponse(id, INTERNAL_ERROR, message),
    );
  }

  private update(update: SessionUpdate): Promise<void> {
    const notice: SessionNotification = { sessionId: this.sessionId, update };
    return this.deliver(jsonRpcNotification(ClientMethods.sessionUpdate, notice));
  }

  private answer(method: string, result: unknown): Promise<boolean> {
    return this.respond(method, (id) => jsonRpcResponse(id, result));
  }

  private async respond(
    method: string,
    responseTo: (id: JsonRpcId) => JsonRpcResponse,
  ): Promise<boolean> {
    const request = this.unanswered(method);
    if (!request) return false;
    this.answeredFrames.add(request.frame);
    await this.deliver(responseTo(request.id));
    return true;
  }

  private unanswered(method: string): SentRequest | null {
    return (
      this.requests(method).findLast((request) => !this.answeredFrames.has(request.frame)) ?? null
    );
  }

  private cancelFrames(): number[] {
    return this.socket.sent.flatMap((text, frame) => {
      const message = parseMessage(text);
      return message && isNotification(message) && message.method === AgentMethods.sessionCancel
        ? [frame]
        : [];
    });
  }

  private requests(method: string): SentRequest[] {
    return this.socket.sent.flatMap((text, frame) => {
      const message = parseMessage(text);
      return message && isRequest(message) && message.method === method
        ? [{ frame, id: message.id }]
        : [];
    });
  }

  private deliver(message: object): Promise<void> {
    return onBridgeMessage(this.workflow, this.socket.connection, JSON.stringify(message));
  }

  /** The connection as the runtime holds it, for the world to drop once it is closed. */
  get connection(): FakeSocket["connection"] {
    return this.socket.connection;
  }
}
