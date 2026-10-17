import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  HarnessSessionReplay,
  SPEC_SETUPS,
  traceSteps,
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

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/harness-session-traces",
);

async function replayPinnedTrace(
  name: string,
  setup: SpecSetup = "harnessDefaultEffort",
): Promise<void> {
  const trace: unknown = JSON.parse(readFileSync(join(PINNED_TRACES, `${name}.itf.json`), "utf8"));
  await replayTrace(setup, traceSteps(setup, trace));
}

describe("harness session spec", () => {
  it("drops the failure of a sandbox start of an older generation", async () => {
    await replayPinnedTrace("stale-sandbox-start-fails");
  });

  it("drops a restart whose container closed after another restart", async () => {
    await replayPinnedTrace("destroy-returns-after-another-restart");
  });

  it("drops a restart whose container closed after the task counted another restart", async () => {
    await replayPinnedTrace("destroy-returns-after-the-restart-counted");
  });

  it("drops the outcome check of a turn of an older generation", async () => {
    await replayPinnedTrace("outcome-check-of-an-older-generation");
  });

  it("keeps a finished task finished when the destroy of an earlier stop returns", async () => {
    await replayPinnedTrace("stop-destroy-returns-after-the-task-finished");
  });

  it("keeps an author out of review while its handshake is pending", async () => {
    await replayPinnedTrace("settle-during-a-handshake");
  });

  it("drops the late answer to a request of an earlier dial", async () => {
    await replayPinnedTrace("late-answer-after-a-redial");
  });

  it("holds the continue prompt of a resume until the cancelled turn ends", async () => {
    await replayPinnedTrace("resume-during-a-cancelled-turn");
  });

  it("keeps a later prompt when the outcome of an earlier turn says blocked", async () => {
    await replayPinnedTrace("blocked-outcome-with-a-later-prompt");
  });

  it("records the outcome of the check that returns last when checks return out of order", async () => {
    await replayPinnedTrace("outcome-checks-return-out-of-order");
  });

  it("counts a refused prompt after a turn that stopped early as a stall", async () => {
    await replayPinnedTrace("refused-prompt-after-a-stopped-early-turn");
  });

  it("closes the container on a stop whose cancel is lost", async () => {
    await replayPinnedTrace("stop-after-the-bridge-died");
  });

  it("restarts the sandbox when the socket closes during the handshake", async () => {
    await replayPinnedTrace("socket-closes-during-the-handshake");
  });

  it("waits for the reconnect when the socket closes during the handshake of a resumed start", async () => {
    await replayPinnedTrace("socket-closes-during-the-handshake-of-a-resumed-start");
  });

  it("leaves a paused restart queued so the resume starts the sandbox", async () => {
    await replayPinnedTrace("restart-held-for-a-resume");
  });

  it("starts a queued restart whose destroy a restart of the instance dropped", async () => {
    await replayPinnedTrace("restart-lost-with-the-instance");
  });

  it("drops a start failure of a task already queued for a restart", async () => {
    await replayPinnedTrace("start-fails-while-queued-for-a-restart");
  });

  it("keeps an author with its page out queued when its woken start fails during a restart", async () => {
    await replayPinnedTrace("start-fails-while-queued-with-the-page-out", "stageAsksForEffort");
  });

  it("keeps a stopped early author queued for its restart through a restart of the instance", async () => {
    await replayPinnedTrace("stopped-early-author-queued-for-a-restart");
  });

  it("settles an author whose outcome check a restart of the instance dropped", async () => {
    await replayPinnedTrace("outcome-check-lost-with-the-instance");
  });

  it("starts a fresh harness session after a lost turn", async () => {
    await replayPinnedTrace("lost-turn-forgets-its-session");
  });

  it("holds a prompt until the effort handshake ends", async () => {
    await replayPinnedTrace("prompt-during-the-effort-handshake", "stageAsksForEffort");
  });

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
