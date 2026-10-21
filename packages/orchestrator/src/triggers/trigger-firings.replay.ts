import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  SPEC_SETUPS,
  TriggerFiringsReplay,
  type SpecSetup,
  type TraceStep,
} from "../../test/trigger-firings-replay";

const TRACES_PER_SETUP = 50;

beforeEach(() => {
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
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
  const replay = new TriggerFiringsReplay(setup);
  try {
    const taken = ["init"];
    const divergence = (step: TraceStep) =>
      `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.view)}`;
    expect(await replay.project(), divergence(initial)).toEqual(initial.view);
    for (const step of steps) {
      taken.push(stepName(step));
      await replay.take(step);
      expect(await replay.project(), divergence(step)).toEqual(step.view);
    }
  } finally {
    replay.close();
  }
}

describe("trigger firings spec", () => {
  for (const setup of SPEC_SETUPS) {
    it(
      `replays its traces through the firing queue and the conversation on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`trigger firings replay ${setup}`, TRACES_PER_SETUP);
        for (const trace of await generateTraces(setup, numRuns, seed))
          await replayTrace(setup, trace);
      },
      propertyTimeoutMs(120_000, TRACES_PER_SETUP),
    );
  }
});
