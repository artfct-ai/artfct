import { jsonRpcNotification, type JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";
import { BridgeMethods, type BridgeExitParams } from "@artfct-ai/acp/methods";
import type { TerminalCloseAction } from "./close-policy";
import { HarnessProcess, type SpawnChild } from "./harness-process";
import type { HarnessSpec, HarnessTransport } from "./harness/types";
import { ServerConnection } from "./server-connection";
import type { SocketDialer } from "./socket";

/** What a harness gets from the bridge so it can talk back. */
export type HarnessCallbacks = {
  onMessage: (message: JsonRpcMessage) => void;
  onExit: (code: number) => void;
};

export type BridgeOptions = {
  /** The harness name, reported in the hello. */
  harness: string;
  /** What to spawn for it. The CLI asks the harness adapter. */
  spec: HarnessSpec;
  dial: string;
  token: string;
  cwd: string;
  model?: string;
  generation?: number;
  log?: (line: string) => void;
  /** Environment for a spawned harness. It never carries the bridge token. */
  env: Record<string, string | undefined>;
  /** Test seam. Defaults to a WebSocket. */
  openSocket?: SocketDialer;
  /** Test seam. Defaults to the harness `spec` names. */
  spawnHarness?: (callbacks: HarnessCallbacks) => HarnessTransport;
  /** Test seam. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Test seam for stdio harnesses. Defaults to `Bun.spawn`. */
  spawnChild?: SpawnChild;
};

const RESTART_EXIT_CODE = 75;
/** Harnesses to kill when the process ends for any reason. */
const liveHarnesses = new Set<HarnessTransport>();
let exitGuardInstalled = false;

function installExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  process.once("exit", () => {
    for (const harness of liveHarnesses) harness.kill();
  });
}

/** Time for the socket to write the exit notification before the process ends. */
export const EXIT_FLUSH_MS = 200;
/** Deadline for the final dial that reports a harness exit while the socket is down. */
export const EXIT_REDIAL_MS = 3000;

/**
 * Relays JSON-RPC between a harness and the orchestrator over an outbound WebSocket.
 * It exits when the harness exits, and kills the harness on every exit path.
 */
export class Bridge {
  private harness: HarnessTransport | null = null;
  private connection: ServerConnection;
  private log: (line: string) => void;
  private exit: (code: number) => void;
  private hellosSent = 0;

  constructor(private options: BridgeOptions) {
    this.log = options.log ?? ((line) => console.error(`[bridge] ${line}`));
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.connection = new ServerConnection({
      dial: options.dial,
      token: options.token,
      hello: () => this.helloParams(),
      onMessage: (message) => this.handleServerMessage(message),
      onTerminalClose: (action, reason) => this.handleServerClose(action, reason),
      log: this.log,
      openSocket: options.openSocket,
    });
  }

  async start(): Promise<void> {
    this.harness = this.startHarness();
    liveHarnesses.add(this.harness);
    installExitGuard();
    this.connection.connect();
  }

  /** `fresh` is true for the first hello of this process only. Every reconnect says false. */
  private helloParams() {
    this.hellosSent += 1;
    return {
      fresh: this.hellosSent === 1,
      harness: this.options.harness,
      generation: this.options.generation ?? 0,
    };
  }

  private startHarness(): HarnessTransport {
    const callbacks: HarnessCallbacks = {
      onMessage: (message) => this.connection.send(message),
      onExit: (code) => void this.handleHarnessExit(code),
    };
    if (this.options.spawnHarness) return this.options.spawnHarness(callbacks);
    const { spec } = this.options;
    return HarnessProcess.spawn(
      {
        command: spec.command,
        cwd: this.options.cwd,
        env: { ...this.options.env, ...spec.env },
        onMessage: callbacks.onMessage,
        onStrayLine: (line) => this.log(`harness stdout: ${line.slice(0, 200)}`),
        onExit: callbacks.onExit,
      },
      this.options.spawnChild,
    );
  }

  private handleServerMessage(message: JsonRpcMessage): void {
    if ("method" in message && message.method === BridgeMethods.restart) {
      this.log("restart requested");
      this.shutdown(RESTART_EXIT_CODE);
      return;
    }
    this.harness?.send(message);
  }

  private handleServerClose(action: TerminalCloseAction, reason: string): void {
    switch (action.kind) {
      case "refused":
        this.log(`server refused (${reason}). exiting.`);
        this.shutdown(action.exitCode);
        break;
      case "clean":
        this.log(`server closed the session (${reason}). exiting.`);
        this.shutdown(action.exitCode);
        break;
      default: {
        const unreachable: never = action;
        throw new Error(`unhandled close action ${String(unreachable)}`);
      }
    }
  }

  /** Report the exit to the server, then exit with the same code. */
  private async handleHarnessExit(code: number): Promise<void> {
    this.log(`harness exited ${code}`);
    const params: BridgeExitParams = { code, signal: null };
    this.connection.send(jsonRpcNotification(BridgeMethods.exit, params));
    const reported = await this.connection.flush(EXIT_REDIAL_MS);
    if (!reported) this.log("the server did not get the exit report");
    await new Promise((resolve) => setTimeout(resolve, EXIT_FLUSH_MS));
    this.shutdown(code);
  }

  /** The one exit path: kill the harness, close the socket, end the process. */
  private shutdown(code: number): void {
    if (this.harness) {
      this.harness.kill();
      liveHarnesses.delete(this.harness);
      this.harness = null;
    }
    this.connection.stop();
    this.connection.close();
    this.exit(code);
  }
}
