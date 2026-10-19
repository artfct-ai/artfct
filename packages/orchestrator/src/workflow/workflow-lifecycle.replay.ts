import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  generateTraces,
  SPEC_SETUPS,
  traceSteps,
  WorkflowLifecycleReplay,
  type SpecSetup,
  type TraceStep,
} from "../../test/workflow-lifecycle-replay";
import { SLEEP_TEXT } from "./lifecycle";

const TRACES_PER_SETUP = 20;

let replay: WorkflowLifecycleReplay | null = null;

afterEach(async () => {
  await replay?.close();
  replay = null;
});

function stepName(step: TraceStep): string {
  const picked = Object.entries(step.picks)
    .filter(([, value]) => value !== null)
    .map(
      ([name, value]) =>
        `${name}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    );
  return picked.length ? `${step.action}(${picked.join(", ")})` : step.action;
}

function idleAlarmSleeps(before: TraceStep, step: TraceStep): boolean {
  return (
    step.action === "idleAlarmFires" &&
    before.workflow.status === "Running" &&
    step.workflow.status === "WaitingInput"
  );
}

async function replayTrace(setup: SpecSetup, trace: TraceStep[]): Promise<void> {
  const [initial, ...steps] = trace;
  if (!initial) throw new Error(`${setup} produced an empty trace`);
  replay = await WorkflowLifecycleReplay.open(setup);
  const taken = ["init"];
  const divergence = (step: TraceStep) =>
    `${setup} diverged after ${taken.join(" -> ")}\nspec state: ${JSON.stringify(step.workflow)}`;
  expect(replay.project(), divergence(initial)).toEqual(initial.workflow);
  let before = initial;
  for (const step of steps) {
    taken.push(stepName(step));
    const worldSteps = await replay.take(step);
    expect(replay.project(), divergence(step)).toEqual(step.workflow);
    const storeBefore = replay.storeBeforeStaleAlarm();
    if (storeBefore !== null)
      expect(replay.world.storeSnapshot(), divergence(step)).toBe(storeBefore);
    const sleepPosted = worldSteps.some((worldStep) => worldStep.postedTexts.includes(SLEEP_TEXT));
    expect(sleepPosted, divergence(step)).toBe(idleAlarmSleeps(before, step));
    const toldTheAgent = worldSteps.some((worldStep) => worldStep.notes.length > 0);
    expect(toldTheAgent, divergence(step)).toBe(step.toldTheAgent);
    expect(replay.answered(), divergence(step)).toBe(step.answered);
    before = step;
  }
  await replay.close();
  replay = null;
}

const PINNED_TRACES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/workflow-lifecycle-traces",
);

describe("workflow lifecycle spec", () => {
  it("keeps the generation of a paused author closed while an acceptance check is out after a dropped restart", async () => {
    const path = join(PINNED_TRACES, "acceptance-check-after-a-dropped-restart.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithoutRefiners", traceSteps("pagesWithoutRefiners", trace));
  });

  it("cancels the author a researcher hands over to while the workflow ends", async () => {
    const path = join(PINNED_TRACES, "author-after-research-while-the-workflow-ends.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesAfterResearch", traceSteps("pagesAfterResearch", trace));
  });

  it("holds the prompt of a second resume for the turn the first resume woke while the restart destroy is out", async () => {
    const path = join(PINNED_TRACES, "resume-again-while-the-restart-destroy-is-out.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithAReviewer", traceSteps("pagesWithAReviewer", trace));
  });

  it("tells the agent of a person's instruct once the revise turn it starts ends", async () => {
    const path = join(PINNED_TRACES, "instruct-waits-for-the-revise-turn.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace(
      "modelCallPagesWithAReviewer",
      traceSteps("modelCallPagesWithAReviewer", trace),
    );
  });

  it("leaves issues a turn records with the humans while the author takes a waiting prompt", async () => {
    const path = join(PINNED_TRACES, "issues-recorded-while-a-prompt-waits.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("issuesForAChatRequest", traceSteps("issuesForAChatRequest", trace));
  });

  it("does not write the page when the model call a stop ended returns", async () => {
    const path = join(PINNED_TRACES, "stop-ends-a-produce-model-call.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("modelCallPagesForAnIssue", traceSteps("modelCallPagesForAnIssue", trace));
  });

  it("leaves the store as it was when the deadline of a model call a stop ended fires", async () => {
    const path = join(PINNED_TRACES, "stale-deadline-of-a-stopped-model-call.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("modelCallPagesForAnIssue", traceSteps("modelCallPagesForAnIssue", trace));
  });

  it("keeps a prompt queued until the page create a stop reached returns", async () => {
    const path = join(PINNED_TRACES, "a-prompt-waits-for-a-stopped-page-create.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("modelCallPagesForAnIssue", traceSteps("modelCallPagesForAnIssue", trace));
  });

  it("leaves the store as it was when the deadline of the turn that produced the page fires", async () => {
    const path = join(PINNED_TRACES, "stale-deadline-of-the-produce-turn.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesFromModelCalls", traceSteps("pagesFromModelCalls", trace));
  });

  it("finishes the cancel of a workflow when an instance restart cut its last destroy", async () => {
    const path = join(PINNED_TRACES, "a-restart-cuts-the-last-destroy-of-a-workflow-end.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithAReviewer", traceSteps("pagesWithAReviewer", trace));
  });

  it("cancels the next author when the alarm goes on with a failure an instance restart cut off", async () => {
    const path = join(PINNED_TRACES, "a-resumed-workflow-end-waits-on-the-next-destroy.itf.json");
    const trace: unknown = JSON.parse(readFileSync(path, "utf8"));
    await replayTrace("pagesWithAReviewer", traceSteps("pagesWithAReviewer", trace));
  });

  for (const setup of Object.keys(SPEC_SETUPS) as SpecSetup[]) {
    it(
      `replays its traces through the workflow on ${setup}`,
      async () => {
        const { numRuns, seed } = propertyRuns(
          `workflow lifecycle replay ${setup}`,
          TRACES_PER_SETUP,
        );
        for (const trace of await generateTraces(setup, numRuns, seed))
          await replayTrace(setup, trace);
      },
      propertyTimeoutMs(60_000, TRACES_PER_SETUP),
    );
  }
});
