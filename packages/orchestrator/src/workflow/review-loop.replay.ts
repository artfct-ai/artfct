import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  endsTheWorkflow,
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
  const alone = traces.filter(endsTheWorkflow).map((trace) => [trace]);
  const sharing = traces.filter((trace) => !endsTheWorkflow(trace));
  const shared = Array.from({ length: Math.ceil(sharing.length / authors) }, (_unused, world) =>
    sharing.slice(world * authors, world * authors + authors),
  );
  return [...alone, ...shared];
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

  it("blocks a conflict on a revision whose failed checks went back", async () => {
    await replayPinnedTrace(
      "conflict-after-failed-checks-on-one-revision",
      "checksOnAPolishedPull",
      315,
    );
  });

  it("sends checks back to the author, blocks its revision, then sends checks back to a waiting polisher", async () => {
    await replayPinnedTrace(
      "checks-go-back-to-the-author-then-to-a-waiting-polisher",
      "checksOnAReviewedPull",
    );
  });

  it("leaves a queued comment unanswered when a comment reply fails", async () => {
    await replayPinnedTrace(
      "reply-fails-beside-a-queued-comment",
      "modelCallAuthorWithTwoReviewers",
    );
  });

  it("asks the agent to route findings when a model-call author's review again call fails", async () => {
    await replayPinnedTrace(
      "review-again-call-fails-on-findings",
      "modelCallAuthorWithTwoReviewers",
    );
  });

  it("answers a queued comment in a turn whose page update fails", async () => {
    await replayPinnedTrace(
      "update-fails-after-answering-a-queued-comment",
      "modelCallAuthorWithTwoReviewers",
    );
  });

  it("stops the recheck alarm when checks open while a reviewer reads a held revision", async () => {
    await replayPinnedTrace(
      "checks-open-while-a-reviewer-reads-a-held-revision",
      "checksOnAReviewedPull",
      36,
    );
  });

  it("stops the recheck alarm when checks open after the author failed with its turn in flight", async () => {
    await replayPinnedTrace(
      "checks-open-after-the-author-failed",
      "checksOnAPolishedPull",
      334481550,
    );
  });

  it("tells the agent of a conflict on an ended author's revision after its failed checks", async () => {
    await replayPinnedTrace(
      "the-agent-hears-of-an-ended-authors-conflict",
      "checksOnAPolishedPull",
    );
  });

  it("routes each done refiner run before the first call a restart cuts", async () => {
    await replayPinnedTrace("a-restart-cuts-the-routing-of-each-done-run", "reviewerThenPolisher");
  });

  it("posts the handover of a polished page before a restart cuts the polisher's destroy", async () => {
    await replayPinnedTrace(
      "a-restart-cuts-the-handover-of-a-polished-page",
      "pageReviewerThenPolisher",
    );
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
