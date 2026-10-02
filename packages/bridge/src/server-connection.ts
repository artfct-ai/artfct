import { jsonRpcNotification, parseMessage, type JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";
import { bridgeTokenHeaders } from "@artfct-ai/acp/bridge-token";
import { BridgeMethods, type BridgeHelloParams } from "@artfct-ai/acp/methods";
import { backoffDelay } from "./backoff";
import { closeAction, type TerminalCloseAction } from "./close-policy";
import { SOCKET_OPEN, dialWebSocket, type SocketDialer, type SocketLike } from "./socket";

export type ServerConnectionOptions = {
  dial: string;
  token: string;
  /** Params for the bridge/hello sent on every open. */
  hello: () => BridgeHelloParams;
  onMessage: (message: JsonRpcMessage) => void;
  /** The server closed with a code that ends the bridge. */
  onTerminalClose: (action: TerminalCloseAction, reason: string) => void;
  log: (line: string) => void;
  /** How sockets are opened. Defaults to a WebSocket. */
  openSocket?: SocketDialer;
};

type PendingFlush = { timer: ReturnType<typeof setTimeout>; settle: (sent: boolean) => void };

/**
 * Outbound WebSocket to the orchestrator. Sends bridge/hello on open,
 * queues messages while disconnected, and reconnects with backoff.
 */
export class ServerConnection {
  private socket: SocketLike | null = null;
  private outbox: string[] = [];
  private attempt = 0;
  private stopped = false;
  private pendingFlush: PendingFlush | null = null;
  private openSocket: SocketDialer;

  constructor(private options: ServerConnectionOptions) {
    this.openSocket = options.openSocket ?? dialWebSocket;
  }

  /** Dial the server. Reconnects on its own until `stop` is called. */
  connect(): void {
    if (this.stopped) return;
    this.dial();
  }

  /** Send now, or queue until the socket is open. */
  send(message: JsonRpcMessage): void {
    const text = JSON.stringify(message);
    if (this.isOpen()) this.socket!.send(text);
    else this.outbox.push(text);
  }

  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN;
  }

  /** Stop reconnecting. Later close events are ignored. */
  stop(): void {
    this.stopped = true;
  }

  close(): void {
    this.socket?.close();
  }

  /** Stop reconnecting and drain the outbox. True when it emptied before `deadlineMs`. */
  flush(deadlineMs: number): Promise<boolean> {
    this.stop();
    if (this.outbox.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settleFlush(false), deadlineMs);
      this.pendingFlush = { timer, settle: resolve };
      this.options.log("final dial to report the exit");
      this.dial();
    });
  }

  private dial(): void {
    const { dial, token } = this.options;
    this.options.log(`dial ${dial} attempt ${this.attempt + 1}`);
    const socket = this.openSocket(dial, bridgeTokenHeaders(token), {
      onOpen: () => this.handleOpen(socket),
      onMessage: (data) => this.handleMessage(data),
      onClose: (code, reason) => this.handleClose(code, reason),
    });
    this.socket = socket;
  }

  private handleOpen(socket: SocketLike): void {
    this.attempt = 0;
    socket.send(JSON.stringify(jsonRpcNotification(BridgeMethods.hello, this.options.hello())));
    for (const text of this.outbox.splice(0)) socket.send(text);
    this.settleFlush(true);
  }

  private handleMessage(data: string): void {
    const message = parseMessage(data);
    if (message) this.options.onMessage(message);
  }

  private handleClose(code: number, reason: string): void {
    if (this.stopped) {
      this.settleFlush(false);
      return;
    }
    const action = closeAction(code);
    if (action.kind !== "retry") {
      this.options.onTerminalClose(action, reason);
      return;
    }
    const wait = backoffDelay(this.attempt);
    this.attempt += 1;
    this.options.log(`socket closed (${code}). retry in ${wait}ms`);
    setTimeout(() => this.connect(), wait);
  }

  private settleFlush(sent: boolean): void {
    const pending = this.pendingFlush;
    if (!pending) return;
    this.pendingFlush = null;
    clearTimeout(pending.timer);
    pending.settle(sent);
  }
}
