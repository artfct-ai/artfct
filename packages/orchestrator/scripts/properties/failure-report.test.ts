import { describe, expect, it } from "bun:test";
import { propertyFailureReport, propertyFailures } from "./failure-report";
import { SPEC_REPLAY_FILES, standalonePropertyFile } from "./property-files";

const BUN_OUTPUT = `src/workflow/invariants.test.ts:
error: Property failed after 19 tests
{ seed: 7, path: "18:0:0:4", endOnFailure: true }
Counterexample: [{"refiners":[]},[]]
Shrunk 10 time(s)
error: nothingReopensAFinishedWorkflow: a prompt event changed the agent notes of a cancelled workflow
(fail) the workflow invariants > hold after every action of any sequence, on any refiner list [1470.12ms]
error: Property failed after 7 tests
{ seed: 7, path: "6:0:1", endOnFailure: true }
error: nothingReopensAFinishedWorkflow: a prompt event changed the agent notes of a failed workflow
(fail) the workflow invariants > hold after every action of any sequence, on a page stage of either ending [1850.82ms]
error: Property failed after 7 tests
{ seed: 7, path: "6:0:1", endOnFailure: true }
error: nothingReopensAFinishedWorkflow: a prompt event changed the agent notes of a failed workflow
`;

const VITEST_OUTPUT = ` FAIL  src/agent/turn/agent-turns.replay.medium.ts > agent turns spec > replays its traces
Error: Property failed after 24 tests
{ seed: -42, path: "23:5:8", endOnFailure: true }
Counterexample: [[{"type":"workflow_ends","surface":"session_b","status":"done"}]]
Shrunk 6 time(s)

Caused by: Error: messageAfterEndStartsNextWorkflow: 2 workflows started after wf_1 ended | twice
`;

const BUN_PROPERTY_OUTPUT = `src/chat/slack/inbound.property.ts:
error: Property failed after 2 tests
{ seed: 5, path: "1:1:0", endOnFailure: true }
Counterexample: [50]
Shrunk 28 time(s)
      at throwIfFailed (fast-check.js:2476:49)
(fail) slack inbound mapper invariants > hold for a JSON value of any shape [1.98ms]
`;

const VITEST_PROPERTY_OUTPUT = ` FAIL  src/oauth/token.property.medium.ts > token refreshes > keep one stored token
Error: Property failed after 2 tests
{ seed: 5, path: "1:1:0", endOnFailure: true }
Counterexample: [50]

Caused by: AssertionError: expected 50 to be less than 50
 FAIL  src/router/identity.property.medium.ts > the access rules > resolve an actor
Error: Property failed after 3 tests
{ seed: 5, path: "2:0", endOnFailure: true }
`;

describe("propertyFailures", () => {
  it("reads each distinct counterexample bun test reports", () => {
    expect(propertyFailures(BUN_OUTPUT)).toEqual([
      {
        invariant:
          "nothingReopensAFinishedWorkflow: a prompt event changed the agent notes of a cancelled workflow",
        seed: 7,
        path: "18:0:0:4",
      },
      {
        invariant:
          "nothingReopensAFinishedWorkflow: a prompt event changed the agent notes of a failed workflow",
        seed: 7,
        path: "6:0:1",
      },
    ]);
  });

  it("reads the cause vitest reports for a counterexample", () => {
    expect(propertyFailures(VITEST_OUTPUT)).toEqual([
      {
        invariant:
          "messageAfterEndStartsNextWorkflow: 2 workflows started after wf_1 ended | twice",
        seed: -42,
        path: "23:5:8",
      },
    ]);
  });

  it("names a bun counterexample without an invariant error by its failing test", () => {
    expect(propertyFailures(BUN_PROPERTY_OUTPUT)).toEqual([
      {
        invariant: "slack inbound mapper invariants > hold for a JSON value of any shape",
        seed: 5,
        path: "1:1:0",
      },
    ]);
  });

  it("names a vitest counterexample without an invariant error by its failing test", () => {
    expect(propertyFailures(VITEST_PROPERTY_OUTPUT)).toEqual([
      { invariant: "token refreshes > keep one stored token", seed: 5, path: "1:1:0" },
      { invariant: "the access rules > resolve an actor", seed: 5, path: "2:0" },
    ]);
  });

  it("reads nothing from output without a fast-check report", () => {
    expect(propertyFailures("error: Cannot find module './gone'\n")).toEqual([]);
  });
});

describe("propertyFailureReport", () => {
  it("names the invariant, seed, path, and replay command of a failure", () => {
    const report = propertyFailureReport(SPEC_REPLAY_FILES["agent-turns"]!, -42, {
      outcome: "failed",
      output: VITEST_OUTPUT,
    });
    expect(report).toContain("### The agent turns spec replay failed on seed -42");
    expect(report).toContain(
      "| messageAfterEndStartsNextWorkflow: 2 workflows started after wf_1 ended \\| twice | -42 | `23:5:8` |",
    );
    expect(report).toContain(
      "PROPERTY_SEED=-42 PROPERTY_RUNS=300 bunx vitest run --config vitest.property.config.ts ./src/agent/turn/agent-turns.replay.medium.ts",
    );
  });

  it("names the seed and replay command of a hang", () => {
    const report = propertyFailureReport(SPEC_REPLAY_FILES["workflow-lifecycle"]!, 9, {
      outcome: "timed_out",
      output: "",
      hungParts: [{ kind: "file" }],
    });
    expect(report).toContain(
      "### The workflow lifecycle spec replay timed out after 20 minutes on seed 9",
    );
    expect(report).toContain("fast-check did not report a counterexample. Read the step log.");
    expect(report).toContain(
      "PROPERTY_SEED=9 PROPERTY_RUNS=1000 bun test ./src/workflow/workflow-lifecycle.replay.ts",
    );
  });

  it("names each setup whose process hung", () => {
    const report = propertyFailureReport(SPEC_REPLAY_FILES["workflow-lifecycle"]!, 9, {
      outcome: "timed_out",
      output: "",
      hungParts: [
        {
          kind: "setup",
          setup: "pagesFromModelCalls",
          testNamePattern: " on pagesFromModelCalls$",
        },
        { kind: "setup", setup: "pullsForTwoIssues", testNamePattern: " on pullsForTwoIssues$" },
      ],
    });
    expect(report).toContain(
      "### The workflow lifecycle spec replay timed out on pagesFromModelCalls, pullsForTwoIssues after 20 minutes on seed 9",
    );
  });

  it("names the package directory a standalone property replays from", () => {
    const report = propertyFailureReport(
      standalonePropertyFile("src/oauth/token.property.medium.ts")!,
      5,
      {
        outcome: "failed",
        output: "",
      },
    );
    expect(report).toContain("Replay it from `packages/orchestrator`:");
    expect(report).toContain(
      "PROPERTY_SEED=5 PROPERTY_RUNS=5000 bunx vitest run --config vitest.property.config.ts ./src/oauth/token.property.medium.ts",
    );
  });

  it("names the divided run count of a light run", () => {
    process.env.PROPERTY_RUNS_DIVISOR = "3";
    try {
      const report = propertyFailureReport(SPEC_REPLAY_FILES["workflow-lifecycle"]!, 9, {
        outcome: "failed",
        output: "",
      });
      expect(report).toContain(
        "PROPERTY_SEED=9 PROPERTY_RUNS=334 bun test ./src/workflow/workflow-lifecycle.replay.ts",
      );
    } finally {
      delete process.env.PROPERTY_RUNS_DIVISOR;
    }
  });
});
