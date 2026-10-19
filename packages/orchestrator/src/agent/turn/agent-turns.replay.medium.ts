import { describe, expect, it } from "vitest";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import {
  AgentTurnsReplay,
  generateTraces,
  SPEC_SETUPS,
  specTrace,
  type SpecSetup,
  type SpecTrace,
  type TraceStep,
} from "../../../test/agent-turns-replay";
import aDecisionsCallFallsBack from "../../../test/agent-turns-traces/a-decisions-call-falls-back.itf.json";
import aFetchedPageIsAdmitted from "../../../test/agent-turns-traces/a-fetched-page-is-admitted.itf.json";
import aPersonHearsBackThenWorkRuns from "../../../test/agent-turns-traces/a-person-hears-back-then-work-runs.itf.json";
import aRestartKeepsTheBackupAlarm from "../../../test/agent-turns-traces/a-restart-keeps-the-backup-alarm.itf.json";
import aTurnIsCompacted from "../../../test/agent-turns-traces/a-turn-is-compacted.itf.json";
import theBackupAlarmFiresDuringItsTurn from "../../../test/agent-turns-traces/the-backup-alarm-fires-during-its-turn.itf.json";

const TRACES_PER_SETUP = 50;

const PINNED_TRACES: { name: string; setup: SpecSetup; trace: unknown }[] = [
  {
    name: "admits a fetched page the screen passes",
    setup: "chatThread",
    trace: aFetchedPageIsAdmitted,
  },
  {
    name: "falls back when a decisions call fails",
    setup: "chatThread",
    trace: aDecisionsCallFallsBack,
  },
  { name: "compacts a turn over the context limit", setup: "chatThread", trace: aTurnIsCompacted },
  {
    name: "answers the person before the work runs",
    setup: "chatThread",
    trace: aPersonHearsBackThenWorkRuns,
  },
  {
    name: "keeps the backup alarm on a restart",
    setup: "chatThread",
    trace: aRestartKeepsTheBackupAlarm,
  },
  {
    name: "runs nothing when the backup alarm fires during its turn",
    setup: "chatThread",
    trace: theBackupAlarmFiresDuringItsTurn,
  },
];

const PICKS_READ: Record<string, (keyof TraceStep["picks"])[]> = {
  personWrites: ["origin"],
  readAnswers: ["owed", "asksForRevision", "namesModel"],
  screenAnswers: ["flagsPage"],
  modelAnswers: ["answer", "overLimit"],
  staleAlarmFires: ["alarm", "armedFor"],
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
  for (const { name, setup, trace } of PINNED_TRACES) {
    it(`${name} on a pinned trace`, async () => {
      await replayTrace(setup, specTrace(setup, trace));
    });
  }

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
