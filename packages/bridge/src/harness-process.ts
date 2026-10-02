import { parseMessage, type JsonRpcMessage } from "@artfct-ai/acp/jsonrpc";
import type { HarnessTransport } from "./harness/types";
import { readLines } from "./line-reader";

export type HarnessProcessOptions = {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** A JSON-RPC message the harness wrote to stdout. */
  onMessage: (message: JsonRpcMessage) => void;
  /** A stdout line that was not JSON-RPC. */
  onStrayLine: (line: string) => void;
  onExit: (code: number) => void;
};

/** The part of a spawned child the harness process uses. A Bun `Subprocess` satisfies it. */
export type HarnessChild = {
  stdout: ReadableStream<Uint8Array>;
  stdin: { write(data: string): unknown; flush(): unknown };
  exited: Promise<number>;
  kill(): void;
};

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "inherit";
};

/** Starts a child process. Test seam. Defaults to `Bun.spawn`. */
export type SpawnChild = (command: string[], options: SpawnOptions) => HarnessChild;

const bunSpawn: SpawnChild = (command, options) => Bun.spawn(command, options);

/** A harness child process speaking newline-delimited JSON-RPC over stdio. Bun only. */
export class HarnessProcess implements HarnessTransport {
  private constructor(private child: HarnessChild) {}

  static spawn(options: HarnessProcessOptions, spawn: SpawnChild = bunSpawn): HarnessProcess {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    void readLines(child.stdout, (line) => {
      const message = parseMessage(line);
      if (message) options.onMessage(message);
      else options.onStrayLine(line);
    });
    void child.exited.then(options.onExit);
    return new HarnessProcess(child);
  }

  send(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.child.stdin.flush();
  }

  kill(): void {
    this.child.kill();
  }
}
