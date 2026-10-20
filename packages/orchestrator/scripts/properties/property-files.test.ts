import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  E2E_RUNS_BY_FILE,
  SPEC_REPLAY_FILES,
  STANDALONE_PROPERTY_FILES,
  propertyParts,
} from "./property-files";

const PACKAGES_DIR = join(import.meta.dirname, "../../..");

const standalonePaths = STANDALONE_PROPERTY_FILES.map((file) => join(file.packageDir, file.path));

describe("STANDALONE_PROPERTY_FILES", () => {
  it("holds every fast-check property outside the spec replays, and each property reads its runs through propertyRuns", async () => {
    const propertyFiles: string[] = [];
    for await (const path of new Bun.Glob("*/src/**/*.ts").scan(PACKAGES_DIR)) {
      if (/\.replay(\.medium)?\.ts$/.test(path)) continue;
      const text = await Bun.file(join(PACKAGES_DIR, path)).text();
      const properties = text.split("fc.assert(").length - 1;
      if (!properties) continue;
      propertyFiles.push(path);
      expect({ path, propertyRuns: text.split("propertyRuns(").length - 1 }).toEqual({
        path,
        propertyRuns: properties,
      });
    }
    expect(standalonePaths).toEqual(propertyFiles.toSorted());
  });
});

describe("E2E_RUNS_BY_FILE", () => {
  it("names only property files the file patterns find", () => {
    const found = new Set([
      ...standalonePaths,
      ...Object.values(SPEC_REPLAY_FILES).map((file) => join(file.packageDir, file.path)),
    ]);
    expect(Object.keys(E2E_RUNS_BY_FILE).filter((path) => !found.has(path))).toEqual([]);
  });
});

describe("propertyParts", () => {
  it("runs a file without setups in one process", () => {
    expect(propertyParts(SPEC_REPLAY_FILES["session-routing"]!, [])).toEqual([
      { label: "session routing spec replay", args: [] },
    ]);
  });

  it("runs a replay of one setup in one process", () => {
    expect(propertyParts(SPEC_REPLAY_FILES["review-loop"]!, ["judgeThenPolisher"])).toEqual([
      { label: "review loop spec replay", args: [] },
    ]);
  });

  it("runs each setup in its own process, and the tests outside a setup with the first", () => {
    const parts = propertyParts(SPEC_REPLAY_FILES["harness-session"]!, [
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
    const parts = propertyParts(SPEC_REPLAY_FILES["review-loop"]!, [
      "reviewerThenPolisher",
      "pageReviewerThenPolisher",
    ]);
    const patterns = parts.map((part) => new RegExp(part.args[1] ?? ""));
    const name =
      "review loop spec replays its traces through the workflow on pageReviewerThenPolisher";
    expect(patterns.map((pattern) => pattern.test(name))).toEqual([false, true]);
  });
});
