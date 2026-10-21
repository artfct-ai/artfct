import { afterEach, describe, it, setSystemTime } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import {
  scheduleExpression,
  scheduleFiresOnItsMinutes,
  type ScheduleFields,
} from "../../test/schedule-invariants";
import { TEST_CONFIG, TEST_DEFINITION_NAME } from "../../test/test-config";
import { loadWorkflowDefinition, type WorkflowDefinition } from "../config/workflow-definition";
import { scheduledFirings } from "./schedule";

const RUNS = 500;

const MINUTE_MS = 60_000;

const DEFINITION = loadWorkflowDefinition(
  TEST_DEFINITION_NAME,
  TEST_CONFIG.workflowDefinitions[0]!.text,
);

/** One field: every value, or a list that may hold the scheduled minute's own value. */
const field = (low: number, high: number) =>
  fc.oneof(
    fc.constant(null),
    fc.record({
      own: fc.boolean(),
      others: fc.uniqueArray(fc.integer({ min: low, max: high }), { minLength: 1, maxLength: 3 }),
    }),
  );

type FieldPick = { own: boolean; others: number[] } | null;

function values(pick: FieldPick, own: number): number[] | null {
  if (pick === null) return null;
  const listed = pick.own ? [...pick.others, own] : pick.others.filter((value) => value !== own);
  const unique = [...new Set(listed)].toSorted((left, right) => left - right);
  return unique.length ? unique : null;
}

const run = fc.record({
  scheduledTime: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2030, 11, 31) }),
  firstLateMs: fc.integer({ min: 0, max: 3 * MINUTE_MS }),
  secondLateMs: fc.integer({ min: 0, max: 3 * MINUTE_MS }),
  minute: field(0, 59),
  hour: field(0, 23),
  day: fc.oneof(
    fc.record({ kind: fc.constant("month" as const), pick: field(1, 31) }),
    fc.record({ kind: fc.constant("week" as const), pick: field(0, 6) }),
  ),
  month: field(1, 12),
});

type RunPicks = typeof run extends fc.Arbitrary<infer Picks> ? Picks : never;

function fieldsAt(picks: RunPicks, minute: Date): ScheduleFields {
  return {
    minute: values(picks.minute, minute.getUTCMinutes()),
    hour: values(picks.hour, minute.getUTCHours()),
    dayOfMonth: picks.day.kind === "month" ? values(picks.day.pick, minute.getUTCDate()) : null,
    month: values(picks.month, minute.getUTCMonth() + 1),
    dayOfWeek: picks.day.kind === "week" ? values(picks.day.pick, minute.getUTCDay()) : null,
  };
}

function withSchedule(schedule: string): WorkflowDefinition {
  return { ...DEFINITION, triggers: [{ schedule, channel: "C1", prompt: "Upgrade." }] };
}

afterEach(() => {
  setSystemTime();
});

describe("scheduled firings", () => {
  it(
    "fire once on each minute their UTC fields match, however late the run starts",
    () => {
      fc.assert(
        fc.property(run, (picks) => {
          const fields = fieldsAt(picks, new Date(picks.scheduledTime));
          const definitions = [withSchedule(scheduleExpression(fields))];
          setSystemTime(new Date(picks.scheduledTime + picks.firstLateMs));
          scheduleFiresOnItsMinutes(
            fields,
            picks.scheduledTime,
            scheduledFirings(definitions, picks.scheduledTime),
          );
          setSystemTime(new Date(picks.scheduledTime + picks.secondLateMs));
          scheduleFiresOnItsMinutes(
            fields,
            picks.scheduledTime,
            scheduledFirings(definitions, picks.scheduledTime),
          );
        }),
        propertyRuns("scheduled firings", RUNS),
      );
    },
    propertyTimeoutMs(30_000, RUNS),
  );
});
