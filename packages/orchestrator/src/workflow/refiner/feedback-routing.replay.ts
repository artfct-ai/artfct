import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  FeedbackRoutingReplay,
  generateTraces,
  SPEC_SETUPS,
  type SpecSetup,
  type TraceStep,
} from "../../../test/feedback-routing-replay";

const TRACES_PER_SETUP = 50;

beforeEach(() => {
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
  const replay = await FeedbackRoutingReplay.open(setup, initial.view);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.view)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.view);
  for (const step of steps) {
    taken.push(stepName(step));
    await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.view);
  }
}

describe("feedback routing spec", () => {
  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(
          `feedback routing replay ${setup}`,
          TRACES_PER_SETUP,
        );
        for (const trace of await generateTraces(setup, numRuns, seed))
          await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
