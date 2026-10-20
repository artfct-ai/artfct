import type { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  destroySandbox,
  keepSleeplessSandboxAwake,
  readSandboxFile,
  refreshSandboxGithubTokens,
  restoreSleepWindow,
  sandboxBridgeRunning,
  startSandbox,
  type SandboxHost,
} from "./container";
import type { AllReposReadToken, SandboxStartSpec } from "./spec";

/**
 * One sandbox: the Durable Object that starts its container and runs commands in it. The
 * Worker's config sets the image and the instance type of each sandbox size.
 */
export class Sandbox extends DurableObject<Env> {
  private files: Promise<Files> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() => restoreSleepWindow({ container, storage: ctx.storage }));
  }

  async start(spec: SandboxStartSpec): Promise<void> {
    await startSandbox(await this.host(), spec);
  }

  async refreshGithubTokens(token: string, read: AllReposReadToken | null): Promise<void> {
    await refreshSandboxGithubTokens(await this.host(), token, read);
  }

  /** Handling the call is the activity that starts the inactivity timeout over. */
  keepAlive(): Promise<void> {
    return Promise.resolve();
  }

  bridgeRunning(generation: number): Promise<boolean> {
    return sandboxBridgeRunning(this.container(), generation);
  }

  async readFile(path: string): Promise<string> {
    return readSandboxFile((await this.host()).files, path);
  }

  async destroy(): Promise<void> {
    await destroySandbox({ container: this.container(), storage: this.ctx.storage });
  }

  override async alarm(): Promise<void> {
    await keepSleeplessSandboxAwake({ container: this.container(), storage: this.ctx.storage });
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("the Sandbox Durable Object has no container binding");
    return container;
  }

  /** The container and storage, with the `Files` helper whose package loads on first use. */
  private async host(): Promise<SandboxHost> {
    const container = this.container();
    this.files ??= import("@cloudflare/sandbox").then(({ Files }) => new Files(container));
    return { container, files: await this.files, storage: this.ctx.storage };
  }
}
