import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How far a model check explores: the `pr` bounds each commit to main checks, or the larger nightly bounds. */
export type TlcDepth = "pr" | "nightly";

/** The cap on each counter val of a setup, by the val's name. */
export type TlcBounds = Record<string, number>;

/** The bounds of one setup at each depth. A setup without `pr` bounds is model checked only at night. */
export type TlcSetupBounds = { pr?: TlcBounds; nightly: TlcBounds };

/** What a spec folder's `checks.json` declares. */
export type SpecChecks = {
  invariants: string[];
  witnesses: Record<string, string[]>;
  tlc?: {
    ignoredVariables: string[];
    bounds: Record<string, TlcSetupBounds>;
  };
};

/** One setup of one spec folder, the unit that CI checks. */
export type SpecSetup = { spec: string; setup: string };

/** The folder that holds one directory per spec. */
export const SPEC_ROOT = join(import.meta.dirname, "../../../../spec");

/** The folder of one spec. */
export function specDir(spec: string): string {
  return join(SPEC_ROOT, spec);
}

/** Reads the checks a spec folder declares. */
export function readSpecChecks(spec: string): SpecChecks {
  return JSON.parse(readFileSync(join(specDir(spec), "checks.json"), "utf8"));
}

/** Every setup of every spec folder, by the setups its witnesses name. */
export function listSpecSetups(): SpecSetup[] {
  return readdirSync(SPEC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((spec) =>
      Object.keys(readSpecChecks(spec).witnesses).map((setup) => ({ spec, setup })),
    );
}
