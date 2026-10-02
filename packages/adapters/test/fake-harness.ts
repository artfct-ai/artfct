import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";
import { planEntries } from "@artfct-ai/acp/updates";
import type {
  Harness,
  HarnessAdapter,
  HarnessCommand,
  HarnessModels,
  HarnessSetup,
  HarnessTaskInput,
} from "../src/harness/types";
import { CallLog, type RecordedCall } from "./calls";

/** Fixed answers for a `FakeHarness`. */
export type HarnessAnswers = {
  /** The name it reports. Default `claude-code`. */
  name?: Harness;
  /** What `setup` returns. Default one marker variable, no files, and no commands. */
  setup?: HarnessSetup;
  /** What `modelRefusal` returns for every model. Default null. */
  refusal?: string | null;
  /** What `models` returns. Default null, a harness that runs the gateway's models. */
  models?: HarnessModels | null;
};

/** Methods a `FakeHarness` records. */
export type HarnessMethod =
  | "setup"
  | "command"
  | "modelRefusal"
  | "modelsLine"
  | "plan"
  | "invokeSkill";

/** An in-memory `HarnessAdapter` that answers as told and records what it was asked. */
export class FakeHarness implements HarnessAdapter {
  private readonly log = new CallLog<HarnessMethod>(false);
  readonly name: Harness;
  readonly instructionsFile = "/home/node/.config/fake/AGENTS.md";
  readonly skillsDir = "/home/node/.config/fake/skills";

  constructor(private readonly answers: HarnessAnswers = {}) {
    this.name = answers.name ?? "claude-code";
  }

  get calls(): RecordedCall<HarnessMethod>[] {
    return this.log.calls;
  }

  invokeSkill(name: string): string {
    this.log.record("invokeSkill", name);
    return `Run the ${name} skill.`;
  }

  modelsLine(): string {
    this.log.record("modelsLine");
    return `${this.name} runs whatever the test says.`;
  }

  async models(): Promise<HarnessModels | null> {
    return this.answers.models ?? null;
  }

  modelRefusal(model: string): string | null {
    this.log.record("modelRefusal", model);
    return this.answers.refusal ?? null;
  }

  command(model: string | undefined): HarnessCommand {
    this.log.record("command", model);
    return { command: ["fake-harness"], env: {} };
  }

  plan(update: SessionUpdate): PlanEntry[] | null {
    this.log.record("plan", update);
    return planEntries(update);
  }

  setup(input: HarnessTaskInput): HarnessSetup {
    this.log.record("setup", input);
    return (
      this.answers.setup ?? { env: { ARTFCT_FAKE_HARNESS: this.name }, files: [], commands: [] }
    );
  }
}
