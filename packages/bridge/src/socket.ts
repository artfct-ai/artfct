/** The part of a WebSocket the bridge uses. Tests substitute a fake. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
};

/** Callbacks a dialer wires to the socket events. */
export type SocketHandlers = {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number, reason: string) => void;
};

/** Opens a socket to `url` with the request `headers` and routes its events to `handlers`. */
export type SocketDialer = (
  url: string,
  headers: Record<string, string>,
  handlers: SocketHandlers,
) => SocketLike;

/** `WebSocket.OPEN`. Spelled out so tests need no WebSocket global. */
export const SOCKET_OPEN = 1;

/** The production dialer: a WebSocket with the handlers attached. */
function ignoreErrorBecauseCloseFollows(): void {}

export function dialWebSocket(
  url: string,
  headers: Record<string, string>,
  handlers: SocketHandlers,
): SocketLike {
  const socket = new WebSocket(url, { headers });
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => handlers.onMessage(String(event.data)));
  socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
  socket.addEventListener("error", ignoreErrorBecauseCloseFollows);
  return socket;
}
