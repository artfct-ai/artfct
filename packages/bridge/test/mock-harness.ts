import type {
  CancelNotification,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  METHOD_NOT_FOUND,
  jsonRpcErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "@artfct-ai/acp/jsonrpc";
import {
  AgentMethods,
  BridgeMethods,
  ClientMethods,
  type BridgeLogParams,
} from "@artfct-ai/acp/methods";
import {
  mockResearchPayload,
  researchPayloadPath,
  writeMockResearchPayload,
} from "./mock-harness-research";
import { fileMockPageReview, isReviewPrompt, reviewedPageId } from "./mock-harness-review";
import type { HarnessTransport } from "../src/harness/types";
import {
  mockStage,
  planForTurn,
  promptText,
  replyForTurn,
  textUpdate,
  toolCallDoneForTurn,
  toolCallForTurn,
  type MockStage,
} from "./mock-harness-turn";

const INVALID_PARAMS = -32602;
const PERMISSION_TIMEOUT_MS = 2000;
const STEP_DELAY_MS = 50;
/** How long a turn works when the prompt says "take your time". Lets a test queue a second prompt. */
const SLOW_TURN_MS = 1500;
/** A prompt that says "never finish" holds its turn until a cancel or the process dies. */
const NEVER_FINISH = /never finish/i;
/** How long a held pull request review waits for its release before it ends its turn anyway. */
const RELEASE_TIMEOUT_MS = 30_000;

type PendingPermission = { id: JsonRpcId; resolve: () => void };
type MockSession = { turns: number; cancelTurn: (() => void) | null };

/**
 * A fake ACP agent for smoke tests. It streams a few updates per prompt and reports an
 * artifact on the first one. ARTFCT_STAGE picks the stage, ARTFCT_MOCK_DOCUMENTS_URL takes review
 * reviews, ARTFCT_MOCK_CONTROL_URL releases a held pull request review, and ARTFCT_MOCK_SANDBOX_ROOT
 * is where a research payload goes.
 */
export class MockHarness implements HarnessTransport {
  private sessions = new Map<string, MockSession>();
  private prUrl: string;
  private stage: MockStage;
  private documentsUrl: string | null;
  private controlUrl: string | null;
  private sandboxRoot: string | null;
  private pendingPermission: PendingPermission | null = null;
  private nextRequestId = 1000;

  constructor(
    private emit: (message: JsonRpcMessage) => void,
    env: Record<string, string | undefined> = process.env,
  ) {
    const repoUrl = env.ARTFCT_MOCK_REPO_URL ?? "https://github.com/acme/app";
    const prNumber = Number(env.ARTFCT_MOCK_PR_NUMBER ?? "1");
    this.prUrl = `${repoUrl}/pull/${prNumber}`;
    this.stage = mockStage(env.ARTFCT_STAGE);
    this.documentsUrl = env.ARTFCT_MOCK_DOCUMENTS_URL ?? null;
    this.controlUrl = env.ARTFCT_MOCK_CONTROL_URL ?? null;
    this.sandboxRoot = env.ARTFCT_MOCK_SANDBOX_ROOT ?? null;
  }

  /** Deliver a client message. Resolves when the mock has finished handling it. */
  async send(message: JsonRpcMessage): Promise<void> {
    if (isResponse(message)) {
      this.resolvePermission(message.id);
      return;
    }
    if (isNotification(message) && message.method === AgentMethods.sessionCancel) {
      this.cancelTurn(message.params as CancelNotification);
      return;
    }
    if (isRequest(message)) await this.handleRequest(message);
  }

  kill(): void {}

  private async handleRequest(incoming: JsonRpcRequest): Promise<void> {
    switch (incoming.method) {
      case AgentMethods.initialize: {
        const result: InitializeResponse = {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false },
        };
        this.emit(jsonRpcResponse(incoming.id, result));
        return;
      }
      case AgentMethods.sessionNew:
        this.emit(
          jsonRpcResponse(incoming.id, this.newSession(incoming.params as NewSessionRequest)),
        );
        return;
      case AgentMethods.sessionPrompt:
        this.emit(await this.prompt(incoming.id, incoming.params as PromptRequest));
        return;
      default:
        this.emit(
          jsonRpcErrorResponse(
            incoming.id,
            METHOD_NOT_FOUND,
            `mock: ${incoming.method} not supported`,
          ),
        );
    }
  }

  private newSession(params: NewSessionRequest): NewSessionResponse {
    const sessionId = `mock-${Math.random().toString(36).slice(2, 10)}`;
    this.sessions.set(sessionId, { turns: 0, cancelTurn: null });
    const mcpNames = params.mcpServers.map((server) => server.name).join(",");
    this.log(`session/new cwd=${params.cwd} mcp=${mcpNames}`);
    return { sessionId };
  }

  private async prompt(id: JsonRpcId, params: PromptRequest): Promise<JsonRpcMessage> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return jsonRpcErrorResponse(id, INVALID_PARAMS, "unknown session");
    session.turns += 1;
    const cancelled = new Promise<void>((resolve) => {
      session.cancelTurn = resolve;
    });
    const stopReason = await this.runTurn({
      sessionId: params.sessionId,
      turn: session.turns,
      prompt: promptText(params.prompt),
      cancelled,
    });
    session.cancelTurn = null;
    const result: PromptResponse = { stopReason };
    return jsonRpcResponse(id, result);
  }

  /** Ends the running prompt turn of the session with the `cancelled` stop reason. */
  private cancelTurn(params: CancelNotification): void {
    this.log(`session/cancel ${params.sessionId}`);
    this.sessions.get(params.sessionId)?.cancelTurn?.();
  }

  private async runTurn(options: {
    sessionId: string;
    turn: number;
    prompt: string;
    cancelled: Promise<void>;
  }): Promise<StopReason> {
    const { sessionId, turn, prompt, cancelled } = options;
    const thought = `turn ${turn}: reading prompt (${prompt.length} chars)`;
    this.update(sessionId, textUpdate("agent_thought_chunk", thought));
    this.update(sessionId, planForTurn(turn, false, this.stage));
    await delay(STEP_DELAY_MS);
    await this.askPermission(sessionId, "Edit src/index.ts");
    this.update(sessionId, toolCallForTurn(turn, this.stage));
    const working = NEVER_FINISH.test(prompt)
      ? new Promise<void>(() => {})
      : delay(/take your time/i.test(prompt) ? SLOW_TURN_MS : STEP_DELAY_MS);
    const outcome = await Promise.race([
      working.then(() => "worked" as const),
      cancelled.then(() => "cancelled" as const),
    ]);
    if (outcome === "cancelled") return "cancelled";
    this.update(sessionId, toolCallDoneForTurn(turn));
    this.update(sessionId, planForTurn(turn, true, this.stage));
    const done = (await this.fileReview(prompt)) ?? (await this.writeResearch(prompt));
    const reply = done ?? replyForTurn({ turn, prompt, prUrl: this.prUrl, stage: this.stage });
    this.update(sessionId, textUpdate("agent_message_chunk", reply));
    if (this.stage.kind === "pr" && isReviewPrompt(prompt)) await this.awaitRelease();
    return "end_turn";
  }

  /** Holds the end of a pull request review until the control host releases it, or the timeout. */
  private async awaitRelease(): Promise<void> {
    const controlUrl = this.controlUrl;
    if (!controlUrl) return;
    const deadline = Date.now() + RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const answer = await fetch(`${controlUrl}/__hold`).catch(() => null);
      if (!answer?.ok) return;
      const { held } = (await answer.json()) as { held: boolean };
      if (!held) return;
      await delay(STEP_DELAY_MS);
    }
  }

  /** Files a review when this turn reviews a page and the run gave it a document host. */
  private async fileReview(prompt: string): Promise<string | null> {
    const documentsUrl = this.documentsUrl;
    if (!documentsUrl) return null;
    const pageId = reviewedPageId(prompt);
    if (!pageId) return null;
    const opening = await fileMockPageReview(documentsUrl, pageId);
    return opening ? `Read the page and filed one comment on it. ${opening}` : null;
  }

  /** Writes the research payload on a researcher's turn. */
  private async writeResearch(prompt: string): Promise<string | null> {
    const sandboxRoot = this.sandboxRoot;
    const path = researchPayloadPath(prompt);
    if (!sandboxRoot || !path) return null;
    const payload = mockResearchPayload(this.stage.name);
    await writeMockResearchPayload({ sandboxRoot, path, payload });
    return `Read the code and wrote the research payload to ${path}.`;
  }

  /** Ask the client for permission. Gives up after a timeout so a silent client cannot stall the turn. */
  private askPermission(sessionId: string, title: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const id = this.nextRequestId++;
      const timer = setTimeout(resolve, PERMISSION_TIMEOUT_MS);
      this.pendingPermission = {
        id,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const params: RequestPermissionRequest = {
        sessionId,
        toolCall: { toolCallId: `perm-${id}`, title, kind: "edit" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      };
      this.emit(jsonRpcRequest(id, ClientMethods.sessionRequestPermission, params));
    });
  }

  private resolvePermission(id: JsonRpcId): void {
    if (!this.pendingPermission || this.pendingPermission.id !== id) return;
    this.pendingPermission.resolve();
    this.pendingPermission = null;
  }

  private update(sessionId: string, update: SessionUpdate): void {
    const params: SessionNotification = { sessionId, update };
    this.emit(jsonRpcNotification(ClientMethods.sessionUpdate, params));
  }

  private log(text: string): void {
    const params: BridgeLogParams = { text };
    this.emit(jsonRpcNotification(BridgeMethods.log, params));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
