import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  ReviewLoopReplay,
  SPEC_SETUPS,
  traceSteps,
  type SpecSetup,
  type TraceStep,
} from "../../test/review-loop-replay";

const TRACES_PER_SETUP = 20;

let replays: ReviewLoopReplay[] = [];

afterEach(async () => {
  for (const replay of replays) await replay.close();
  replays = [];
});

function seededShuffle<T>(items: T[], seed: number): T[] {
  const [shuffled] = fc.sample(fc.shuffledSubarray(items, { minLength: items.length }), {
    seed,
    numRuns: 1,
  });
  if (!shuffled) throw new Error("the shuffle sampled nothing");
  return shuffled;
}

async function openReplays(
  setup: SpecSetup,
  traces: TraceStep[][],
  seed: number,
): Promise<ReviewLoopReplay[]> {
  const [first, ...others] = traces;
  if (!first) throw new Error(`${setup} produced no trace`);
  const opened = [await ReviewLoopReplay.open(setup, first, seed)];
  replays = opened;
  for (const [index, trace] of others.entries()) {
    opened.push(await ReviewLoopReplay.openBeside(opened[0]!, trace, seed + index + 1));
  }
  return opened;
}

async function replayTraces(setup: SpecSetup, traces: TraceStep[][], seed: number): Promise<void> {
  const opened = await openReplays(setup, traces, seed);
  const taken = ["init"];
  const divergence = (replay: ReviewLoopReplay, step: TraceStep) =>
    `${setup} seed ${seed} diverged on author ${opened.indexOf(replay)} after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.review)}`;
  for (const replay of opened) {
    expect(replay.project(), divergence(replay, replay.current)).toEqual(replay.current.review);
  }
  const turns = seededShuffle(
    opened.flatMap((replay, index) => Array.from({ length: replay.stepsLeft }, () => index)),
    seed,
  );
  for (const turn of turns) {
    const replay = opened[turn]!;
    const step = await replay.take();
    taken.push(`${turn}:${step.action}${JSON.stringify(step.picks)}`);
    for (const each of opened) {
      expect(each.project(), divergence(each, each.current)).toEqual(each.current.review);
      for (const { step: heardAt, agentHeard } of each.settledHeard()) {
        expect(agentHeard, `${divergence(each, heardAt)}\nagent read at ${heardAt.action}`).toEqual(
          heardAt.agentHeard,
        );
      }
    }
  }
}

function inWorlds(traces: TraceStep[][], authors: number): TraceStep[][][] {
  return Array.from({ length: Math.ceil(traces.length / authors) }, (_unused, world) =>
    traces.slice(world * authors, world * authors + authors),
  );
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/review-loop-traces",
);

async function replayPinnedTrace(name: string, setup: SpecSetup, seed = 0): Promise<void> {
  const trace: unknown = JSON.parse(readFileSync(join(PINNED_TRACES, `${name}.itf.json`), "utf8"));
  await replayTraces(setup, [traceSteps(setup, trace)], seed);
}

describe("review loop spec", () => {
  it("rules on a judge run whose ruling call a new instance lost", async () => {
    await replayPinnedTrace("ruling-call-lost-with-the-instance", "judgeThenPolisher");
  });

  it("holds the ruling call of a judge that closes after a cancelled run", async () => {
    await replayPinnedTrace(
      "judge-closes-after-a-cancelled-run",
      "pageJudgeBetweenReviewers",
      413067186,
    );
  });

  it("holds the ruling call of a judge that closes after findings", async () => {
    await replayPinnedTrace("judge-closes-after-findings", "pageJudgeBetweenReviewers", 413898815);
  });

  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(`review loop replay ${setup}`, TRACES_PER_SETUP);
        const traces = await generateTraces(setup, numRuns, seed);
        for (const [world, traced] of inWorlds(traces, SPEC_SETUPS[setup].authors).entries()) {
          await replayTraces(setup, traced, seed + world * traced.length);
          for (const replay of replays) await replay.close();
          replays = [];
        }
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
