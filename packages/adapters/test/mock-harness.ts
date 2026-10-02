import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import { planEntries } from "@artfct-ai/acp/updates";
import {
  SANDBOX_HOME,
  type Harness,
  type HarnessAdapter,
  type HarnessCommand,
  type HarnessSetup,
  type HarnessTaskInput,
} from "../src/harness/types";

/**
 * The harness adapter of the smoke run and the workerd tests. It stands in for every harness name,
 * and the sandbox runs the bridge's in-process mock harness for it.
 */
export class MockHarness implements HarnessAdapter {
  constructor(readonly name: Harness) {}

  readonly instructionsFile = `${SANDBOX_HOME}/.config/artfct-mock/AGENTS.md`;
  readonly skillsDir = `${SANDBOX_HOME}/.config/artfct-mock/skills`;

  invokeSkill(name: string): string {
    return `Read the \`${name}\` skill and follow it for this task.`;
  }

  modelsLine(): string {
    return `${this.name} runs no model here and fabricates its artifact.`;
  }

  async models(): Promise<null> {
    return null;
  }

  modelRefusal(): string | null {
    return null;
  }

  command(): HarnessCommand {
    return { command: [], env: {} };
  }

  plan(update: SessionUpdate): PlanEntry[] | null {
    return planEntries(update);
  }

  setup(input: HarnessTaskInput): HarnessSetup {
    const env: Record<string, string> = input.repoFull
      ? { ARTFCT_MOCK_REPO_URL: `https://github.com/${input.repoFull}` }
      : {};
    return { env, files: [], commands: [] };
  }
}
