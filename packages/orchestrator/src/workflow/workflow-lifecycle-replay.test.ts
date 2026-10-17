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
import { SLEEP_TEXT } from "./lifecycle";

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

function idleAlarmSleeps(before: TraceStep, step: TraceStep): boolean {
  return (
    step.action === "idleAlarmFires" &&
    before.workflow.status === "Running" &&
    step.workflow.status === "WaitingInput"
  );
}

async function replayTrace(setup: SpecSetup, trace: TraceStep[]): Promise<void> {
  const [initial, ...steps] = trace;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  replay = await WorkflowLifecycleReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.workflow)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.workflow);
  let before = initial;
  for (const step of steps) {
    taken.push(stepName(step));
    const worldSteps = await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.workflow);
    const sleepPosted = worldSteps.some((worldStep) => worldStep.postedTexts.includes(SLEEP_TEXT));
    expect(sleepPosted, divergence(step)).toBe(idleAlarmSleeps(before, step));
    if (step.action === "staleAlarmFires") {
      expect(
        worldSteps.flatMap((worldStep) => worldStep.notes),
        divergence(step),
      ).toEqual([]);
    }
    before = step;
  }
  await replay.close();
  replay = null;
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/workflow-lifecycle-traces",
);

describe("workflow lifecycle spec", () => {
  it("keeps the generation of a paused author closed while an acceptance check is out after a dropped restart", async () => {
    const path = join(PINNED_TRACES, "acceptance-check-after-a-dropped-restart.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithoutRefiners", traceSteps("pagesWithoutRefiners", trace));
  });

  it("cancels the author a researcher hands over to while the workflow ends", async () => {
    const path = join(PINNED_TRACES, "author-after-research-while-the-workflow-ends.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesAfterResearch", traceSteps("pagesAfterResearch", trace));
  });

  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(
          `workflow lifecycle replay ${setup}`,
          TRACES_PER_SETUP,
        );
        for (const trace of await generateTraces(setup, numRuns, seed))
          await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
