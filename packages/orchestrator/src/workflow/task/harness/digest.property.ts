import type { PlanEntry } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "bun:test";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import { TASK_STATUSES } from "@artfct-ai/contracts/types";
import fc from "fast-check";
import { taskDigestStaysWithinItsCap } from "../../../../test/orchestrator-text-invariants";
import type { DigestInput } from "../../board/types";
import { taskDigest } from "./digest";

const RUNS = 100;

const anyText = (maxLength: number) =>
  fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.string({ unit: "grapheme", maxLength }),
    fc.nat(maxLength).map((length) => "x".repeat(length)),
    fc.nat(maxLength).map((length) => "line\n".repeat(Math.ceil(length / 5))),
  );

const planEntry: fc.Arbitrary<PlanEntry> = fc.record({
  content: anyText(300),
  priority: fc.constantFrom("high", "medium", "low"),
  status: fc.constantFrom("pending", "in_progress", "completed"),
});

const digestInput: fc.Arbitrary<DigestInput> = fc.record({
  task: fc.record({
    task_id: fc.oneof(fc.constant("wf_x.2"), anyText(600)),
    number: fc.nat(),
    ticket_key: fc.option(anyText(40)),
    workflow_name: anyText(300),
    work: fc.oneof(
      fc.record({ stage: anyText(100) }),
      fc.record({ phase: fc.constantFrom("review" as const, "polish" as const) }),
    ),
    status: fc.constantFrom(...TASK_STATUSES),
    paused: fc.boolean(),
    started_at: fc.oneof(
      fc
        .date({ noInvalidDate: true, min: new Date(0), max: new Date("2100-01-01T00:00:00Z") })
        .map((date) => date.toISOString()),
      anyText(30),
    ),
    cost_usd: fc.oneof(
      fc.constant(null),
      fc.constant(0),
      fc.double(),
      fc.double({ min: 0, max: 1000 }),
    ),
  }),
  artifact: fc.option(
    fc.record({
      kind: fc.oneof(fc.constantFrom("pull", "page", "issues"), anyText(40)),
      external_url: fc.oneof(
        fc.constant("https://github.com/acme/app/pull/7"),
        anyText(1500).map((path) => `https://github.com/${path}`),
      ),
      status: fc.oneof(fc.constantFrom("drafted", "accepted", "removed"), anyText(40)),
    }),
  ),
  todos: fc.option(fc.record({ entries: fc.array(planEntry, { maxLength: 6 }) })),
  counters: fc.record({
    tool_calls: fc.nat(1000),
    tool_failures: fc.integer({ min: -1, max: 20 }),
    failed_tools: fc.array(anyText(200), { maxLength: 8 }),
  }),
  last: fc.option(anyText(3000)),
  note: fc.option(anyText(400)),
  now: fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
});

const TASK_ID_PAST_THE_CAP: DigestInput = {
  task: {
    task_id: " ".repeat(371),
    number: 0,
    ticket_key: null,
    workflow_name: "",
    work: { stage: "" },
    status: "working",
    paused: false,
    started_at: "",
    cost_usd: 0,
  },
  artifact: null,
  todos: null,
  counters: { tool_calls: 0, tool_failures: 0, failed_tools: [] },
  last: null,
  note: null,
  now: 0,
};

function headFieldChars(input: DigestInput): number {
  return (
    input.task.task_id.length +
    input.task.workflow_name.length +
    (input.artifact?.external_url.length ?? 0) +
    input.counters.failed_tools.slice(0, 5).join("").length
  );
}

describe("task digest invariants", () => {
  it(
    "the digest holds at most 500 characters for any task",
    () => {
      let headFieldsPastTheCap = 0;
      fc.assert(
        fc.property(digestInput, (input) => {
          if (headFieldChars(input) > 500) headFieldsPastTheCap++;
          taskDigestStaysWithinItsCap(taskDigest(input));
        }),
        {
          ...propertyRuns("task digest stays within its cap", RUNS),
          examples: [[TASK_ID_PAST_THE_CAP]],
        },
      );
      expect(headFieldsPastTheCap).toBeGreaterThan(0);
    },
    propertyTimeoutMs(5_000, RUNS),
  );
});
