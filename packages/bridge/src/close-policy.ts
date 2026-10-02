/** What the bridge does after the server closes the socket. */
export type CloseAction =
  | { kind: "refused"; exitCode: 3 }
  | { kind: "clean"; exitCode: 0 }
  | { kind: "retry" };

/** A close action that ends the bridge process. */
export type TerminalCloseAction = Exclude<CloseAction, { kind: "retry" }>;

/** Map a WebSocket close code to a bridge action. Unknown codes mean reconnect. */
export function closeAction(code: number): CloseAction {
  switch (code) {
    case 4001:
      return { kind: "refused", exitCode: 3 };
    case 1000:
      return { kind: "clean", exitCode: 0 };
    default:
      return { kind: "retry" };
  }
}
