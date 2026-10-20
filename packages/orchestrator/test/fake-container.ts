import type { FileContent, MkdirOptions } from "@cloudflare/sandbox";
import type {
  SandboxContainer,
  SandboxFiles,
  SandboxHost,
  SandboxStorage,
} from "../src/sandbox/container";

/** One command a fake container ran, with the options it ran under. */
export type FakeExec = { argv: string[]; options: ContainerExecOptions };

/** What a fake container answers to one command. */
export type FakeExecResult = { exitCode: number; stderr?: string };

/** A container that records its commands and answers each with a scripted exit code. */
export class FakeContainer implements SandboxContainer {
  running = false;
  starts: ContainerStartupOptions[] = [];
  execs: FakeExec[] = [];
  inactivityTimeouts: number[] = [];
  destroyed = 0;

  constructor(private answer: (argv: string[]) => FakeExecResult = () => ({ exitCode: 0 })) {}

  start(options?: ContainerStartupOptions): void {
    if (options) this.starts.push(options);
    this.running = true;
  }

  async exec(argv: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
    if (!this.running) throw new Error("the container is not running");
    this.execs.push({ argv, options });
    const { exitCode, stderr = "" } = this.answer(argv);
    const output: ExecOutput = {
      exitCode,
      stdout: new ArrayBuffer(0),
      stderr: await new Response(stderr).arrayBuffer(),
    };
    return {
      stdin: null,
      stdout: null,
      stderr: null,
      pid: this.execs.length,
      isPty: false,
      exitCode: Promise.resolve(exitCode),
      output: async () => output,
      kill: () => {},
      resize: () => {},
    };
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    this.running = false;
  }

  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    this.inactivityTimeouts.push(Number(durationMs));
  }
}

/** A container file system held in memory. It writes text only. */
export class FakeFiles implements SandboxFiles {
  files = new Map<string, string>();
  dirs: string[] = [];

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    if (!options?.recursive) throw new Error("the fake makes directories recursively only");
    this.dirs.push(path);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    if (typeof content !== "string") throw new Error("the fake writes text only");
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<Response> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`readFile '${path}': ENOENT`);
    return new Response(content);
  }
}

/** Durable Object storage held in memory, with its one alarm. */
export class FakeStorage implements SandboxStorage {
  values = new Map<string, number>();
  alarm: number | null = null;

  async get(key: string): Promise<number | undefined> {
    return this.values.get(key);
  }

  async put(key: string, value: number): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** A sandbox host of fakes, with each fake exposed for assertions. */
export function fakeSandboxHost(answer?: (argv: string[]) => FakeExecResult): SandboxHost & {
  container: FakeContainer;
  files: FakeFiles;
  storage: FakeStorage;
} {
  return {
    container: new FakeContainer(answer),
    files: new FakeFiles(),
    storage: new FakeStorage(),
  };
}
