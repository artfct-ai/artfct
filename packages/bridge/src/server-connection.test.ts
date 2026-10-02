import { isNotification, jsonRpcNotification, type JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";
import { BridgeMethods } from "@artfct-ai/acp/methods";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { advanceTimersAsync } from "../test/advance-timers";
import { backoffDelay } from "./backoff";
import { ServerConnection } from "./server-connection";
import { SOCKET_OPEN, type SocketHandlers, type SocketLike } from "./socket";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: JsonRpcMessage[] = [];
  closed = false;

  constructor(
    public url: string,
    public headers: Record<string, string>,
    private handlers: SocketHandlers,
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as JsonRpcMessage);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.readyState = SOCKET_OPEN;
    this.handlers.onOpen();
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.handlers.onClose(code, reason);
  }

  serverMessage(data: string): void {
    this.handlers.onMessage(data);
  }
}

function connect() {
  const sockets: FakeSocket[] = [];
  const received: JsonRpcMessage[] = [];
  const terminal: string[] = [];
  const connection = new ServerConnection({
    dial: "ws://localhost/bridge/wf/task",
    token: "t",
    hello: () => ({ fresh: true, harness: "fake", generation: 0 }),
    onMessage: (message) => received.push(message),
    onTerminalClose: (action) => terminal.push(action.kind),
    log: () => {},
    openSocket: (url, headers, handlers) => {
      const socket = new FakeSocket(url, headers, handlers);
      sockets.push(socket);
      return socket;
    },
  });
  connection.connect();
  return { connection, sockets, received, terminal };
}

function methodsOf(socket: FakeSocket): string[] {
  return socket.sent.filter(isNotification).map((message) => message.method);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("ServerConnection", () => {
  let connection: ServerConnection;
  let sockets: FakeSocket[];
  let received: JsonRpcMessage[];
  let terminal: string[];

  beforeEach(() => {
    ({ connection, sockets, received, terminal } = connect());
  });

  describe("the first dial", () => {
    it("goes to the dial url as it was given", () => {
      expect(sockets[0]!.url).toBe("ws://localhost/bridge/wf/task");
    });

    it("carries the token in the authorization header", () => {
      expect(sockets[0]!.headers).toEqual({ authorization: "Bearer t" });
    });
  });

  describe("sockets that keep failing", () => {
    it("redials each time, no sooner than the backoff", async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = backoffDelay(attempt);
        sockets[attempt]!.serverClose(1006);
        await advanceTimersAsync(wait - 1);
        expect(sockets).toHaveLength(attempt + 1);
        await advanceTimersAsync(1);
        expect(sockets).toHaveLength(attempt + 2);
      }
    });

    it("waits longer after each failure", () => {
      expect(backoffDelay(2)).toBeGreaterThan(backoffDelay(0));
    });
  });

  describe("a socket that opens after two failures", () => {
    beforeEach(async () => {
      sockets[0]!.serverClose(1006);
      await advanceTimersAsync(backoffDelay(0));
      sockets[1]!.serverClose(1006);
      await advanceTimersAsync(backoffDelay(1));
      sockets[2]!.open();
    });

    it("dialed once for each failure", () => {
      expect(sockets).toHaveLength(3);
    });

    describe("and then closes", () => {
      beforeEach(() => {
        sockets[2]!.serverClose(1006);
      });

      it("waits only the first backoff again", async () => {
        await advanceTimersAsync(backoffDelay(0) - 1);
        expect(sockets).toHaveLength(3);
        await advanceTimersAsync(1);
        expect(sockets).toHaveLength(4);
      });
    });
  });

  describe("a connection the bridge stopped", () => {
    beforeEach(async () => {
      connection.stop();
      sockets[0]!.serverClose(1006);
      await advanceTimersAsync(60_000);
    });

    it("does not redial", () => {
      expect(sockets).toHaveLength(1);
    });
  });

  describe("a server that refuses the token", () => {
    beforeEach(() => {
      sockets[0]!.open();
      sockets[0]!.serverClose(4001, "bad token");
    });

    it("reports the close as terminal", () => {
      expect(terminal).toEqual(["refused"]);
    });

    it("does not redial", async () => {
      await advanceTimersAsync(60_000);
      expect(sockets).toHaveLength(1);
    });
  });

  describe("a message queued while the socket is down", () => {
    beforeEach(() => {
      connection.send(jsonRpcNotification("x"));
    });

    describe("a flush that waits for delivery", () => {
      let flushed: Promise<boolean>;

      beforeEach(() => {
        flushed = connection.flush(5000);
      });

      it("dials a second socket", () => {
        expect(sockets).toHaveLength(2);
      });

      describe("when that socket closes too", () => {
        beforeEach(() => {
          sockets[1]!.serverClose(1006);
        });

        it("settles the flush with false", async () => {
          await expect(flushed).resolves.toBe(false);
        });

        it("does not dial again", async () => {
          await advanceTimersAsync(60_000);
          expect(sockets).toHaveLength(2);
        });
      });
    });

    describe("a flush that reaches its deadline", () => {
      it("settles with false", async () => {
        const flushed = connection.flush(1000);
        await advanceTimersAsync(1000);
        await expect(flushed).resolves.toBe(false);
      });
    });
  });

  describe("a flush with nothing queued", () => {
    it("resolves true at once", async () => {
      await expect(connection.flush(1000)).resolves.toBe(true);
    });

    it("dials no second socket", async () => {
      await connection.flush(1000);
      expect(sockets).toHaveLength(1);
    });
  });

  describe("messages sent while the socket is down", () => {
    beforeEach(async () => {
      sockets[0]!.open();
      connection.send(jsonRpcNotification("a"));
      sockets[0]!.serverClose(1006);
      connection.send(jsonRpcNotification("b"));
      connection.send(jsonRpcNotification("c"));
      await advanceTimersAsync(backoffDelay(0));
    });

    it("sends nothing before the new socket opens", () => {
      expect(sockets[1]!.sent).toEqual([]);
    });

    describe("when the new socket opens", () => {
      beforeEach(() => {
        sockets[1]!.open();
      });

      it("sends the hello first, then the queue in order", () => {
        expect(methodsOf(sockets[1]!)).toEqual([BridgeMethods.hello, "b", "c"]);
      });

      it("leaves the delivered message on the socket that carried it", () => {
        expect(methodsOf(sockets[0]!)).toEqual([BridgeMethods.hello, "a"]);
      });
    });
  });

  describe("a server frame that is not JSON-RPC", () => {
    it("drops it and keeps the frames around it", () => {
      sockets[0]!.open();
      sockets[0]!.serverMessage("not json");
      sockets[0]!.serverMessage(JSON.stringify({ jsonrpc: "2.0", method: "ping" }));
      expect(received.map((message) => ("method" in message ? message.method : null))).toEqual([
        "ping",
      ]);
    });
  });
});
