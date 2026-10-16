import { afterEach, describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  HarnessSessionReplay,
  SPEC_SETUPS,
  type SpecSetup,
  type TraceStep,
} from "../../../../test/harness-session-replay";

const TRACES_PER_SETUP = 20;

let replay: HarnessSessionReplay | null = null;

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
  replay = await HarnessSessionReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.task)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.task);
  for (const step of steps) {
    taken.push(stepName(step));
    await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.task);
  }
  await replay.close();
  replay = null;
}

describe("harness session spec", () => {
  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`harness session replay ${setup}`, TRACES_PER_SETUP);
        for (const trace of generateTraces(setup, numRuns, seed)) await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
