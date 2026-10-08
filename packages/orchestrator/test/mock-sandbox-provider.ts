import type { SandboxProvider } from "../src/sandbox/provider";
import {
  bridgeCommand,
  bridgeEnv,
  startupScript,
  type SandboxRef,
  type SandboxStartSpec,
} from "../src/sandbox/spec";

/** Posts start requests to a local mock host (scripts/mock-sandbox.ts). Used by the smoke test. */
export class MockSandboxProvider implements SandboxProvider {
  constructor(private baseUrl: string) {}

  async start(spec: SandboxStartSpec): Promise<void> {
    await this.post("/start", {
      ...spec,
      startup_script: startupScript(spec),
      bridge_command: bridgeCommand(spec),
      bridge_env: bridgeEnv(spec),
    });
  }

  async setEnv(sandbox: SandboxRef, env: Record<string, string>): Promise<void> {
    await this.post("/env", { sandbox_id: sandbox.id, env });
  }

  /** The mock bridge never pushes, so the token is only logged as an env change. */
  async refreshGithubTokens(sandbox: SandboxRef, token: string): Promise<void> {
    await this.post("/env", { sandbox_id: sandbox.id, env: { GITHUB_TOKEN: token } });
  }

  /** The mock host has no sleep timer. */
  keepAlive(): Promise<void> {
    return Promise.resolve();
  }

  /** The mock host reads the file from the directory that stands for the sandbox's container. */
  async readFile(sandbox: SandboxRef, path: string): Promise<string> {
    const response = await this.post("/read", { sandbox_id: sandbox.id, path });
    return response.text();
  }

  async destroy(sandbox: SandboxRef): Promise<void> {
    await this.post("/destroy", { sandbox_id: sandbox.id });
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`mock sandbox ${path}: ${response.status} ${await response.text()}`);
    }
    return response;
  }
}
