import { beforeEach, describe, expect, it } from "bun:test";
import { HarnessProcess, type HarnessChild, type SpawnOptions } from "./harness-process";

function fakeChild() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const writes: string[] = [];
  const flushes: number[] = [];
  let killed = 0;
  const child: HarnessChild = {
    stdout,
    stdin: {
      write: (data: string) => writes.push(data),
      flush: () => flushes.push(writes.length),
    },
    exited,
    kill: () => {
      killed += 1;
    },
  };
  const encoder = new TextEncoder();
  return {
    child,
    writes,
    flushes,
    killed: () => killed,
    emit: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    exit,
  };
}

function spawnWith(fake: ReturnType<typeof fakeChild>) {
  const spawned: Array<{ command: string[]; options: SpawnOptions }> = [];
  const messages: unknown[] = [];
  const strays: string[] = [];
  const exits: number[] = [];
  const process = HarnessProcess.spawn(
    {
      command: ["agent", "acp"],
      cwd: "/work",
      env: { A: "1" },
      onMessage: (message) => messages.push(message),
      onStrayLine: (line) => strays.push(line),
      onExit: (code) => exits.push(code),
    },
    (command, options) => {
      spawned.push({ command, options });
      return fake.child;
    },
  );
  return { process, spawned, messages, strays, exits };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("HarnessProcess", () => {
  let fake: ReturnType<typeof fakeChild>;
  let started: ReturnType<typeof spawnWith>;

  beforeEach(() => {
    fake = fakeChild();
    started = spawnWith(fake);
  });

  describe("the spawn", () => {
    it("runs the command with piped stdio in the given cwd and env", () => {
      expect(started.spawned).toEqual([
        {
          command: ["agent", "acp"],
          options: {
            cwd: "/work",
            env: { A: "1" },
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
          },
        },
      ]);
    });
  });

  describe("messages the bridge sends", () => {
    beforeEach(() => {
      started.process.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
      started.process.send({ jsonrpc: "2.0", method: "session/cancel" });
    });

    it("writes one JSON line per message", () => {
      expect(fake.writes).toEqual([
        '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
        '{"jsonrpc":"2.0","method":"session/cancel"}\n',
      ]);
    });

    it("flushes after each message", () => {
      expect(fake.flushes).toEqual([1, 2]);
    });
  });

  describe("lines the child writes to stdout", () => {
    beforeEach(async () => {
      fake.emit('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\nstarting up\n');
      fake.emit('{"jsonrpc":"2.0","method":"session/update"}');
      fake.end();
      await settle();
    });

    it("routes the JSON-RPC lines to onMessage", () => {
      expect(started.messages).toEqual([
        { jsonrpc: "2.0", id: 1, result: { ok: true } },
        { jsonrpc: "2.0", method: "session/update" },
      ]);
    });

    it("routes the other lines to onStrayLine", () => {
      expect(started.strays).toEqual(["starting up"]);
    });
  });

  describe("a child that is still running", () => {
    it("reports no exit", () => {
      expect(started.exits).toEqual([]);
    });

    describe("after the child exits", () => {
      beforeEach(async () => {
        fake.exit(75);
        await settle();
      });

      it("passes the exit code to onExit", () => {
        expect(started.exits).toEqual([75]);
      });
    });
  });

  describe("a kill", () => {
    it("kills the child", () => {
      started.process.kill();
      expect(fake.killed()).toBe(1);
    });
  });
});
