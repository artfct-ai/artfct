import type { Env } from "../env";
import type { Sandbox } from "./durable-object";
import type { SandboxProvider } from "./provider";
import type { AllReposReadToken, SandboxRef, SandboxSize, SandboxStartSpec } from "./spec";

/** The RPC methods of one sandbox Durable Object. Tests pass a fake with the same shape. */
export type SandboxStub = Pick<
  Sandbox,
  "start" | "refreshGithubTokens" | "keepAlive" | "bridgeRunning" | "readFile" | "destroy"
>;

/** Opens the stub of one sandbox. The default reads the namespace of its size. */
export type SandboxStubFactory = (sandbox: SandboxRef) => SandboxStub;

/**
 * Runs sandboxes on Cloudflare Containers. Each sandbox is a Durable Object that drives its
 * container. Every call on its stub starts its inactivity timeout over. The bridge socket does not.
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  private getStub: SandboxStubFactory;

  constructor(env: Env, getStub?: SandboxStubFactory) {
    this.getStub =
      getStub ?? ((sandbox) => sandboxNamespace(env, sandbox.size).getByName(sandbox.id));
  }

  async start(spec: SandboxStartSpec): Promise<void> {
    await this.getStub({ id: spec.sandbox_id, size: spec.size }).start(spec);
  }

  async bridgeRunning(sandbox: SandboxRef, generation: number): Promise<boolean> {
    return this.getStub(sandbox).bridgeRunning(generation);
  }

  async refreshGithubTokens(
    sandbox: SandboxRef,
    token: string,
    read: AllReposReadToken | null,
  ): Promise<void> {
    await this.getStub(sandbox).refreshGithubTokens(token, read);
  }

  async keepAlive(sandbox: SandboxRef): Promise<void> {
    await this.getStub(sandbox).keepAlive();
  }

  async readFile(sandbox: SandboxRef, path: string): Promise<string> {
    return this.getStub(sandbox).readFile(path);
  }

  async destroy(sandbox: SandboxRef): Promise<void> {
    await this.getStub(sandbox).destroy();
  }
}

/** The Durable Object namespace whose containers run on the instance type of a size. */
function sandboxNamespace(env: Env, size: SandboxSize): Env["Sandbox"] {
  const namespaces: Record<SandboxSize, Env["Sandbox"]> = {
    small: env.Sandbox,
    large: env.SandboxLarge,
  };
  return namespaces[size];
}
