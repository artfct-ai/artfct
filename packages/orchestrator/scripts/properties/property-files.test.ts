import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SPEC_REPLAY_FILES, STANDALONE_PROPERTY_FILES, propertyParts } from "./property-files";

const PACKAGES_DIR = join(import.meta.dirname, "../../..");

describe("STANDALONE_PROPERTY_FILES", () => {
  it("lists every test file with a fast-check property, and each property reads its runs through propertyRuns", async () => {
    const propertyTests: string[] = [];
    for await (const path of new Bun.Glob("*/src/**/*.{test.ts,test.medium.ts}").scan(
      PACKAGES_DIR,
    )) {
      const text = await Bun.file(join(PACKAGES_DIR, path)).text();
      const properties = text.split("fc.assert(").length - 1;
      if (!properties) continue;
      propertyTests.push(path);
      expect({ path, propertyRuns: text.split("propertyRuns(").length - 1 }).toEqual({
        path,
        propertyRuns: properties,
      });
    }
    const listed = Object.values(STANDALONE_PROPERTY_FILES).map((file) =>
      join(file.packageDir, file.path),
    );
    expect(listed.toSorted()).toEqual(propertyTests.toSorted());
  });
});

describe("propertyParts", () => {
  it("runs a file without setups in one process", () => {
    expect(propertyParts(SPEC_REPLAY_FILES.session_routing, [])).toEqual([
      { label: "session routing spec replay", args: [] },
    ]);
  });

  it("runs a replay of one setup in one process", () => {
    expect(propertyParts(SPEC_REPLAY_FILES.review_loop, ["judgeThenPolisher"])).toEqual([
      { label: "review loop spec replay", args: [] },
    ]);
  });

  it("runs each setup in its own process, and the tests outside a setup with the first", () => {
    const parts = propertyParts(SPEC_REPLAY_FILES.harness_session, [
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
    const parts = propertyParts(SPEC_REPLAY_FILES.review_loop, [
      "reviewerThenPolisher",
      "pageReviewerThenPolisher",
    ]);
    const patterns = parts.map((part) => new RegExp(part.args[1] ?? ""));
    const name =
      "review loop spec replays its traces through the workflow on pageReviewerThenPolisher";
    expect(patterns.map((pattern) => pattern.test(name))).toEqual([false, true]);
  });
});
