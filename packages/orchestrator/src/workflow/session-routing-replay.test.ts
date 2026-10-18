import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  SessionRoutingReplay,
  SPEC_SETUPS,
  traceSteps,
  type SpecSetup,
  type TraceStep,
} from "../../test/session-routing-replay";

const TRACES_PER_SETUP = 20;

let replay: SessionRoutingReplay | null = null;

afterEach(() => {
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
  replay = await SessionRoutingReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.routing)}\nspec output: ${JSON.stringify(step.output)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.routing);
  for (const step of steps) {
    taken.push(stepName(step));
    const output = await replay.take(step);
    expect(output, divergence(step)).toEqual(step.output);
    expect(replay.project(), divergence(step)).toEqual(step.routing);
  }
  replay = null;
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/session-routing-traces",
);

describe("session routing spec", () => {
  it("tells a person in the starting session that the agent turn timed out", async () => {
    const path = join(PINNED_TRACES, "timeout-after-a-message-in-the-starting-session.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("trackerOnly", traceSteps("trackerOnly", trace));
  });

  it("tells a person in a sub-issue session whose author failed that the agent turn timed out", async () => {
    const path = join(
      PINNED_TRACES,
      "timeout-in-a-sub-issue-session-after-its-author-failed.itf.json",
    );
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("trackerOnly", traceSteps("trackerOnly", trace));
  });

  it("ends the feed of an author that gives up after its restarts on the error", async () => {
    const path = join(PINNED_TRACES, "an-author-fails-on-an-error-after-its-restarts.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("trackerOnly", traceSteps("trackerOnly", trace));
  });

  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`session routing replay ${setup}`, TRACES_PER_SETUP);
        for (const trace of await generateTraces(setup, numRuns, seed))
          await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
