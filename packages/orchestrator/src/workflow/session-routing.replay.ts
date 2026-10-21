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
    if (step.messages) expect(replay.messages(), divergence(step)).toEqual(step.messages);
    if (step.cutClosingReplies) {
      expect(replay.cutClosingReplies(), divergence(step)).toEqual(step.cutClosingReplies);
    }
    if (step.narration) expect(replay.narration(), divergence(step)).toEqual(step.narration);
  }
  replay = null;
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/session-routing-traces",
);

const PINNED: { name: string; setup: SpecSetup; file: string }[] = [
  {
    name: "tells a person in the starting session that the agent turn timed out",
    setup: "trackerOnly",
    file: "timeout-after-a-message-in-the-starting-session",
  },
  {
    name: "tells a person in a sub-issue session whose author failed that the agent turn timed out",
    setup: "trackerOnly",
    file: "timeout-in-a-sub-issue-session-after-its-author-failed",
  },
  {
    name: "ends the feed of an author that gives up after its restarts on the error",
    setup: "trackerOnly",
    file: "an-author-fails-on-an-error-after-its-restarts",
  },
  {
    name: "cancels the job of a sub-issue session on a verbal cancel and answers the person",
    setup: "trackerOnly",
    file: "cancel-in-a-sub-issue-session-cancels-its-job",
  },
  {
    name: "cancels the workflow on a verbal cancel in the starting session and stops the running author",
    setup: "trackerOnly",
    file: "cancel-in-the-starting-session-cancels-the-workflow",
  },
  {
    name: "pauses the author on a verbal pause in a session of a chat workflow and answers in chat",
    setup: "chatThread",
    file: "pause-in-a-session-of-a-chat-workflow",
  },
  {
    name: "wakes the agent on a verbal pause while two jobs run",
    setup: "trackerOnly",
    file: "pause-in-a-session-while-two-jobs-run",
  },
  {
    name: "sends the resumed author its prompt once the turn the pause cancelled ends",
    setup: "trackerOnly",
    file: "a-resumed-author-goes-on-after-the-cancel",
  },
  {
    name: "tells the starting session that a researcher failed after its restarts",
    setup: "trackerResearch",
    file: "a-researcher-fails-after-its-restarts",
  },
  {
    name: "restarts a researcher whose turn gave up after it wrote its payload",
    setup: "trackerResearch",
    file: "a-researcher-that-gave-up-restarts",
  },
  {
    name: "restarts a researcher that the harness stopped on a limit after it wrote its payload",
    setup: "trackerResearch",
    file: "a-researcher-stopped-on-a-limit-restarts",
  },
  {
    name: "posts the closing reply of a cancelled turn once on its alarm after restarts cut its posts",
    setup: "trackerOnly",
    file: "a-closing-reply-cut-by-restarts-posts-once-on-its-alarm",
  },
  {
    name: "ends the feed on the stopped reply when a stop lands during the model call of an author in review",
    setup: "trackerModelCall",
    file: "a-stop-ends-the-model-call-of-an-author-in-review",
  },
];

describe("session routing spec", () => {
  for (const { name, setup, file } of PINNED) {
    it(name, async () => {
      const trace: unknown = JSON.parse(
        readFileSync(join(PINNED_TRACES, `${file}.itf.json`), "utf8"),
      );
      await replayTrace(setup, traceSteps(setup, trace));
    });
  }

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
