import { afterEach, describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  RouterBindingsReplay,
  SPEC_SETUPS,
  type SpecSetup,
  type TraceStep,
} from "../../test/router-bindings-replay";

const TRACES_PER_SETUP = 20;

let replay: RouterBindingsReplay | null = null;

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

async function replayTrace(
  setup: SpecSetup,
  trace: TraceStep[],
  firstEndedStatus: number,
): Promise<void> {
  const [initial, ...steps] = trace;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  replay = new RouterBindingsReplay(firstEndedStatus);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.view)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.view);
  for (const step of steps) {
    taken.push(stepName(step));
    await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.view);
  }
  await replay.close();
  replay = null;
}

describe("router bindings spec", () => {
  for (const setup of SPEC_SETUPS) {
    it(
      `replays its traces through the router on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`router bindings replay ${setup}`, TRACES_PER_SETUP);
        const traces = await generateTraces(setup, numRuns, seed);
        for (const [index, trace] of traces.entries()) await replayTrace(setup, trace, index);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
