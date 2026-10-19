import { describe, expect, it } from "vitest";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  AgentTurnsReplay,
  generateTraces,
  SPEC_SETUPS,
  type SpecSetup,
  type SpecTrace,
  type TraceStep,
} from "../../../test/agent-turns-replay";

const TRACES_PER_SETUP = 10;

const PICKS_READ: Record<string, (keyof TraceStep["picks"])[]> = {
  personWrites: ["origin"],
  readAnswers: ["owed", "asksForRevision", "namesModel"],
  screenAnswers: ["flagsPage"],
  modelAnswers: ["answer", "overLimit"],
};

function stepName(step: TraceStep): string {
  const picks = (PICKS_READ[step.action] ?? []).map(
    (name) => `${name}=${JSON.stringify(step.picks[name])}`,
  );
  return picks.length ? `${step.action}(${picks.join(" ")})` : step.action;
}

async function replayTrace(setup: SpecSetup, trace: SpecTrace): Promise<void> {
  const [initial, ...steps] = trace.steps;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  await AgentTurnsReplay.open(setup, trace.models, async (replay) => {
    const taken = [`init(models=${trace.models.join(",")})`];
    const divergence = () => `${setup} diverged after ${taken.join(" -> ")}`;
    expect(replay.view(), divergence()).toEqual(initial.view);
    for (const step of steps) {
      taken.push(stepName(step));
      await replay.take(step);
      expect(replay.failures(), divergence()).toEqual([]);
      expect(replay.view(), divergence()).toEqual(step.view);
    }
  });
}

describe("agent turns spec", () => {
  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the agent turn on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`agent turns replay ${setup}`, TRACES_PER_SETUP);
        for (const trace of await generateTraces(setup, numRuns, seed)) {
          await replayTrace(setup, trace);
        }
      },
      propertyTimeoutMs(120_000, TRACES_PER_SETUP),
    );
  }
});
