import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How far a model check explores: the small `pr` bounds for a local check, or the larger bounds the nightly run checks. */
export type TlcDepth = "pr" | "nightly";

/** The cap on each counter val of a setup, by the val's name. */
export type TlcBounds = Record<string, number>;

/** What a spec folder's `checks.json` declares. */
export type SpecChecks = {
  invariants: string[];
  mainMinutes: Record<string, number>;
  witnesses: Record<string, string[]>;
  /** Longer traces for a setup whose witnesses need more steps than the default. */
  maxSteps?: Record<string, number>;
  tlc?: {
    ignoredVariables: string[];
    bounds: Record<string, Record<TlcDepth, TlcBounds>>;
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
