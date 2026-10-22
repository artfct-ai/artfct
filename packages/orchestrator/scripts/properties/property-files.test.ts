import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  E2E_RUNS_BY_FILE,
  SPEC_REPLAY_FILES,
  STANDALONE_PROPERTY_FILES,
  propertyParts,
  type PropertyPart,
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

function setupParts(parts: PropertyPart[]) {
  return parts.flatMap((part) => (part.kind === "setup" ? [part] : []));
}

describe("propertyParts", () => {
  it("runs a file without setups in one process", () => {
    expect(propertyParts([])).toEqual([{ kind: "file" }]);
  });

  it("runs a replay of one setup in one process", () => {
    expect(propertyParts(["judgeThenPolisher"])).toEqual([{ kind: "file" }]);
  });

  it("runs each setup in its own process, and the tests outside a setup with the first", () => {
    const parts = setupParts(
      propertyParts(["harnessDefaultEffort", "stageAsksForEffort", "agentPausesRunningTurns"]),
    );
    expect(parts.map((part) => part.setup)).toEqual([
      "harnessDefaultEffort",
      "stageAsksForEffort",
      "agentPausesRunningTurns",
    ]);
    const takenBy = (name: string) =>
      parts.flatMap((part) => (new RegExp(part.testNamePattern).test(name) ? [part.setup] : []));
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
    const parts = setupParts(propertyParts(["reviewerThenPolisher", "pageReviewerThenPolisher"]));
    const name =
      "review loop spec replays its traces through the workflow on pageReviewerThenPolisher";
    expect(parts.map((part) => new RegExp(part.testNamePattern).test(name))).toEqual([false, true]);
  });
});
