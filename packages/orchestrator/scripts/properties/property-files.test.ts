import { describe, expect, it } from "bun:test";
import { PROPERTY_FILES, propertyParts } from "./property-files";

describe("propertyParts", () => {
  it("runs a file without setups in one process", () => {
    expect(propertyParts(PROPERTY_FILES.workflow, [])).toEqual([
      { label: "workflow properties", args: [] },
    ]);
  });

  it("runs a replay of one setup in one process", () => {
    expect(propertyParts(PROPERTY_FILES.review_loop, ["judgeThenPolisher"])).toEqual([
      { label: "review loop spec replay", args: [] },
    ]);
  });

  it("runs each setup in its own process, and the tests outside a setup with the first", () => {
    const parts = propertyParts(PROPERTY_FILES.harness_session, [
      "harnessDefaultEffort",
      "stageAsksForEffort",
      "agentPausesRunningTurns",
    ]);
    expect(parts.map((part) => part.label)).toEqual([
      "harnessDefaultEffort",
      "stageAsksForEffort",
      "agentPausesRunningTurns",
    ]);
    const patterns = parts.map((part) => new RegExp(part.args[1] ?? ""));
    const takenBy = (name: string) =>
      parts.flatMap((part, index) => (patterns[index]?.test(name) ? [part.label] : []));
    const spec = "harness session spec";
    expect(
      takenBy(`${spec} replays its traces through the workflow on harnessDefaultEffort`),
    ).toEqual(["harnessDefaultEffort"]);
    expect(
      takenBy(`${spec} replays its traces through the workflow on stageAsksForEffort`),
    ).toEqual(["stageAsksForEffort"]);
    expect(
      takenBy(`${spec} replays its traces through the workflow on agentPausesRunningTurns`),
    ).toEqual(["agentPausesRunningTurns"]);
    expect(takenBy(`${spec} holds a prompt until the effort handshake ends`)).toEqual([
      "harnessDefaultEffort",
    ]);
  });

  it("keeps a setup apart from another whose name ends with it", () => {
    const parts = propertyParts(PROPERTY_FILES.review_loop, [
      "reviewerThenPolisher",
      "pageReviewerThenPolisher",
    ]);
    const patterns = parts.map((part) => new RegExp(part.args[1] ?? ""));
    const name =
      "review loop spec replays its traces through the workflow on pageReviewerThenPolisher";
    expect(patterns.map((pattern) => pattern.test(name))).toEqual([false, true]);
  });
});
