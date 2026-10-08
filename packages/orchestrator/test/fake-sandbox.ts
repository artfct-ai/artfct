import type { SandboxProvider } from "../src/sandbox/provider";
import type { AllReposReadToken, SandboxRef, SandboxStartSpec } from "../src/sandbox/spec";

/** Records every provider call. Tests assert on `calls` and place files to read with `putFile`. */
export class FakeSandboxProvider implements SandboxProvider {
  calls: string[] = [];
  specs: SandboxStartSpec[] = [];
  private files = new Map<string, Map<string, string>>();

  /** Place a file in a sandbox so a later `readFile` returns its content. */
  putFile(sandboxId: string, path: string, content: string): void {
    const sandboxFiles = this.files.get(sandboxId) ?? new Map<string, string>();
    sandboxFiles.set(path, content);
    this.files.set(sandboxId, sandboxFiles);
  }

  async start(spec: SandboxStartSpec): Promise<void> {
    this.calls.push(`start ${spec.sandbox_id}`);
    this.specs.push(spec);
  }

  async setEnv(sandbox: SandboxRef): Promise<void> {
    this.calls.push(`setEnv ${sandbox.id}`);
  }

  async refreshGithubTokens(
    sandbox: SandboxRef,
    token: string,
    read: AllReposReadToken | null,
  ): Promise<void> {
    const readLabel = read ? ` read ${read.token} ${read.workflow_repo}` : "";
    this.calls.push(`refreshGithubTokens ${sandbox.id} ${token}${readLabel}`);
  }

  async keepAlive(sandbox: SandboxRef): Promise<void> {
    this.calls.push(`keepAlive ${sandbox.id}`);
  }

  async readFile(sandbox: SandboxRef, path: string): Promise<string> {
    this.calls.push(`readFile ${sandbox.id} ${path}`);
    const content = this.files.get(sandbox.id)?.get(path);
    if (content === undefined) throw new Error(`no file at ${path} in sandbox ${sandbox.id}`);
    return content;
  }

  async destroy(sandbox: SandboxRef): Promise<void> {
    this.calls.push(`destroy ${sandbox.id}`);
  }
}
