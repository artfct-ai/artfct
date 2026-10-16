import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  SPEC_SETUPS,
  traceSteps,
  WorkflowLifecycleReplay,
  type SpecSetup,
  type TraceStep,
} from "../../test/workflow-lifecycle-replay";

const TRACES_PER_SETUP = 20;

let replay: WorkflowLifecycleReplay | null = null;

afterEach(async () => {
  await replay?.close();
  replay = null;
});

function stepName(step: TraceStep): string {
  const picked = Object.entries(step.picks)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${String(value)}`);
  return picked.length ? `${step.action}(${picked.join(", ")})` : step.action;
}

async function replayTrace(setup: SpecSetup, trace: TraceStep[]): Promise<void> {
  const [initial, ...steps] = trace;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  replay = await WorkflowLifecycleReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.workflow)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.workflow);
  for (const step of steps) {
    taken.push(stepName(step));
    await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.workflow);
  }
  await replay.close();
  replay = null;
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/workflow-lifecycle-traces",
);

describe("workflow lifecycle spec", () => {
  it("keeps a generation closed while an acceptance check is out after a dropped restart", async () => {
    const path = join(PINNED_TRACES, "acceptance-check-after-a-dropped-restart.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithoutRefiners", traceSteps("pagesWithoutRefiners", trace));
  });

  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(
          `workflow lifecycle replay ${setup}`,
          TRACES_PER_SETUP,
        );
        for (const trace of generateTraces(setup, numRuns, seed)) await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
