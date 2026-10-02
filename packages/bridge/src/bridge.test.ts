import { isNotification, isResponse, resultOf, type JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";
import { BridgeMethods } from "@artfct-ai/acp/methods";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { advanceTimersAsync } from "../test/advance-timers";
import {
  Bridge,
  EXIT_FLUSH_MS,
  EXIT_REDIAL_MS,
  type BridgeOptions,
  type HarnessCallbacks,
} from "./bridge";
import type { SpawnOptions } from "./harness-process";
import type { HarnessTransport } from "./harness/types";
import { SOCKET_OPEN, type SocketHandlers, type SocketLike } from "./socket";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: JsonRpcMessage[] = [];
  closed = false;

  constructor(private handlers: SocketHandlers) {}

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

  serverMessage(message: JsonRpcMessage): void {
    this.handlers.onMessage(JSON.stringify(message));
  }
}

class FakeHarness implements HarnessTransport {
  killed = 0;
  received: JsonRpcMessage[] = [];
  constructor(public callbacks: HarnessCallbacks) {}
  send(message: JsonRpcMessage): void {
    this.received.push(message);
  }
  kill(): void {
    this.killed += 1;
  }
}

function baseOptions(overrides: Partial<BridgeOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const exits: number[] = [];
  const options: BridgeOptions = {
    harness: "fake",
    spec: { command: ["fake-harness"], env: {} },
    dial: "ws://localhost/bridge/wf/task",
    token: "t",
    cwd: "/tmp",
    env: {},
    log: () => {},
    openSocket: (_url, _headers, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
    exit: (code) => exits.push(code),
    ...overrides,
  };
  return { options, sockets, exits };
}

function startBridge() {
  const spawned: { harness: FakeHarness | null } = { harness: null };
  const { options, sockets, exits } = baseOptions({
    spawnHarness: (callbacks) => {
      spawned.harness = new FakeHarness(callbacks);
      return spawned.harness;
    },
  });
  void new Bridge(options).start();
  if (!spawned.harness) throw new Error("the bridge did not spawn the harness");
  return { sockets, exits, harness: spawned.harness };
}

function methodsOf(socket: FakeSocket): string[] {
  return socket.sent.filter(isNotification).map((message) => message.method);
}

function helloFresh(socket: FakeSocket): boolean | undefined {
  for (const message of socket.sent) {
    if (!isNotification(message) || message.method !== BridgeMethods.hello) continue;
    return (message.params as { fresh?: boolean } | undefined)?.fresh;
  }
  return undefined;
}

const BACKOFF_CEILING_MS = 30_000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("Bridge", () => {
  let sockets: FakeSocket[];
  let exits: number[];
  let harness: FakeHarness;

  beforeEach(() => {
    ({ sockets, exits, harness } = startBridge());
  });

  describe("a socket that is open", () => {
    beforeEach(() => {
      sockets[0]!.open();
    });

    it("says fresh on the first hello", () => {
      expect(helloFresh(sockets[0]!)).toBe(true);
    });

    it("forwards a server message to the harness", () => {
      sockets[0]!.serverMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
      expect(harness.received).toHaveLength(1);
    });

    it("forwards a harness message to the socket", () => {
      harness.callbacks.onMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      const last = sockets[0]!.sent.at(-1)!;
      expect(isResponse(last) ? resultOf(last) : null).toEqual({ ok: true });
    });

    describe("after the socket drops and the bridge redials", () => {
      beforeEach(async () => {
        sockets[0]!.serverClose(1006);
        await advanceTimersAsync(1000);
        sockets[1]!.open();
      });

      it("dials a second socket", () => {
        expect(sockets).toHaveLength(2);
      });

      it("says it is no longer fresh", () => {
        expect(helloFresh(sockets[1]!)).toBe(false);
      });
    });
  });

  describe("a harness that exits while the socket is down", () => {
    beforeEach(async () => {
      sockets[0]!.serverClose(1006);
      harness.callbacks.onExit(1);
      await advanceTimersAsync(0);
    });

    it("dials again at once", () => {
      expect(sockets).toHaveLength(2);
    });

    describe("when the new socket opens", () => {
      beforeEach(() => {
        sockets[1]!.open();
      });

      it("reports the exit after the hello", () => {
        expect(methodsOf(sockets[1]!)).toEqual([BridgeMethods.hello, BridgeMethods.exit]);
      });

      it("waits for the report to flush before it exits", () => {
        expect(exits).toEqual([]);
      });

      describe("once the flush window passes", () => {
        beforeEach(async () => {
          await advanceTimersAsync(EXIT_FLUSH_MS);
        });

        it("exits with the harness code", () => {
          expect(exits).toEqual([1]);
        });

        it("kills the harness", () => {
          expect(harness.killed).toBe(1);
        });

        it("closes the socket", () => {
          expect(sockets[1]!.closed).toBe(true);
        });

        it("does not dial again", async () => {
          await advanceTimersAsync(60_000);
          expect(sockets).toHaveLength(2);
        });
      });
    });
  });

  describe("a harness exit the bridge cannot report", () => {
    beforeEach(async () => {
      sockets[0]!.serverClose(1006);
      harness.callbacks.onExit(2);
      await advanceTimersAsync(0);
    });

    it("dials again at once", () => {
      expect(sockets).toHaveLength(2);
    });

    describe("while the new socket never opens", () => {
      beforeEach(async () => {
        await advanceTimersAsync(EXIT_REDIAL_MS - 1);
      });

      it("still waits", () => {
        expect(exits).toEqual([]);
      });

      describe("past the redial and flush deadlines", () => {
        beforeEach(async () => {
          await advanceTimersAsync(1 + EXIT_FLUSH_MS);
        });

        it("exits with the harness code", () => {
          expect(exits).toEqual([2]);
        });

        it("kills the harness", () => {
          expect(harness.killed).toBe(1);
        });
      });
    });
  });

  describe("a server that refuses the token", () => {
    beforeEach(() => {
      sockets[0]!.open();
      sockets[0]!.serverClose(4001, "bad token");
    });

    it("exits 3", () => {
      expect(exits).toEqual([3]);
    });

    it("kills the harness", () => {
      expect(harness.killed).toBe(1);
    });

    it("closes the socket", () => {
      expect(sockets[0]!.closed).toBe(true);
    });

    it("does not redial", async () => {
      await advanceTimersAsync(BACKOFF_CEILING_MS * 2);
      expect(sockets).toHaveLength(1);
    });
  });

  describe("a restart request from the server", () => {
    beforeEach(() => {
      sockets[0]!.open();
      sockets[0]!.serverMessage({ jsonrpc: "2.0", method: BridgeMethods.restart });
    });

    it("exits 75", () => {
      expect(exits).toEqual([75]);
    });

    it("kills the harness", () => {
      expect(harness.killed).toBe(1);
    });

    it("does not pass the request on to the harness", () => {
      expect(harness.received).toEqual([]);
    });
  });

  describe("a clean close from the server", () => {
    beforeEach(() => {
      sockets[0]!.open();
      sockets[0]!.serverClose(1000);
    });

    it("exits 0", () => {
      expect(exits).toEqual([0]);
    });

    it("kills the harness", () => {
      expect(harness.killed).toBe(1);
    });

    it("closes the socket", () => {
      expect(sockets[0]!.closed).toBe(true);
    });

    it("does not redial", async () => {
      await advanceTimersAsync(BACKOFF_CEILING_MS * 2);
      expect(sockets).toHaveLength(1);
    });
  });
});

describe("Bridge default harness path", () => {
  describe("a spec with a command", () => {
    let spawned: Array<{ command: string[]; options: SpawnOptions }>;

    beforeEach(() => {
      spawned = [];
      const { options } = baseOptions({
        harness: "claude-code",
        spec: { command: ["claude-agent-acp"], env: { ANTHROPIC_MODEL: "claude-x" } },
        cwd: "/work",
        env: { HOME: "/home/ao", ANTHROPIC_MODEL: "overridden" },
        spawnChild: (command, spawnOptions) => {
          spawned.push({ command, options: spawnOptions });
          return {
            stdout: new ReadableStream<Uint8Array>(),
            stdin: { write: () => {}, flush: () => {} },
            exited: new Promise<number>(() => {}),
            kill: () => {},
          };
        },
      });
      void new Bridge(options).start();
    });

    it("spawns one child", () => {
      expect(spawned).toHaveLength(1);
    });

    it("runs the command the spec names", () => {
      expect(spawned[0]?.command).toEqual(["claude-agent-acp"]);
    });

    it("runs it in the given cwd", () => {
      expect(spawned[0]?.options.cwd).toBe("/work");
    });

    it("puts the spec env over the process env", () => {
      expect(spawned[0]?.options.env).toEqual({ HOME: "/home/ao", ANTHROPIC_MODEL: "claude-x" });
    });

    it("pipes stdin", () => {
      expect(spawned[0]?.options.stdin).toBe("pipe");
    });
  });
});
