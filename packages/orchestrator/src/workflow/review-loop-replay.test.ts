import { afterEach, describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  ReviewLoopReplay,
  SPEC_SETUPS,
  type SpecSetup,
  type TraceStep,
} from "../../test/review-loop-replay";

const TRACES_PER_SETUP = 20;

let replay: ReviewLoopReplay | null = null;

afterEach(async () => {
  await replay?.close();
  replay = null;
});

async function replayTrace(setup: SpecSetup, trace: TraceStep[]): Promise<void> {
  const [initial, ...steps] = trace;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  replay = await ReviewLoopReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.review)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.review);
  for (const step of steps) {
    taken.push(`${step.action}${JSON.stringify(step.picks)}`);
    await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.review);
    for (const { step: heardAt, agentHeard } of replay.settledHeard()) {
      const expected = steps[heardAt - 1];
      if (!expected) throw new Error(`the replay took step ${heardAt} the trace lacks`);
      expect(agentHeard, `${divergence(expected)}\nagent read at step ${heardAt}`).toEqual(
        expected.agentHeard,
      );
    }
  }
  await replay.close();
  replay = null;
}

describe("review loop spec", () => {
  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`review loop replay ${setup}`, TRACES_PER_SETUP);
        for (const trace of generateTraces(setup, numRuns, seed)) await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
