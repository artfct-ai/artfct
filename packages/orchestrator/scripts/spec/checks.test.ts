import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listModelCheckedSetups, listSpecSetups, readSpecChecks, specDir } from "./checks";

describe("listSpecSetups", () => {
  it("lists a setup file for every setup", () => {
    const setups = listSpecSetups();
    expect(setups.length).toBeGreaterThan(0);
    for (const { spec, setup } of setups) {
      expect(readFileSync(join(specDir(spec), `${setup}.qnt`), "utf8")).toContain(
        `module ${setup} {`,
      );
      expect(readSpecChecks(spec).mainMinutes[setup]).toBeGreaterThan(0);
    }
  });

  it("bounds each model checked setup at both depths, in its own setup file", () => {
    const setups = listModelCheckedSetups();
    expect(setups.length).toBeGreaterThan(0);
    for (const { spec, setup } of setups) {
      expect(readFileSync(join(specDir(spec), `${setup}.qnt`), "utf8")).toContain(
        `module ${setup} {`,
      );
      const depths = readSpecChecks(spec).tlc?.bounds[setup] ?? {};
      expect(Object.keys(depths).toSorted()).toEqual(["nightly", "pr"]);
    }
  });
});
