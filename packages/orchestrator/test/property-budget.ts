/** The variables the main gate sets to run a property test longer, on a seed it reports. */
const PROPERTY_VARS = ["PROPERTY_RUNS", "PROPERTY_SEED"] as const;

/** The fast-check parameters and the test timeout of one property test. */
export type PropertyBudget = {
  parameters: { numRuns: number; seed?: number };
  timeoutMs: number;
};

/**
 * The budget of a property test. A pull request runs the defaults. The main gate sets
 * `PROPERTY_RUNS` and `PROPERTY_SEED`, and the timeout grows with the run count.
 */
export function propertyBudget(defaults: { runs: number; timeoutMs: number }): PropertyBudget {
  const runs = process.env.PROPERTY_RUNS;
  const seed = process.env.PROPERTY_SEED;
  const numRuns = runs ? Number(runs) : defaults.runs;
  return {
    parameters: seed ? { numRuns, seed: Number(seed) } : { numRuns },
    timeoutMs: Math.ceil((defaults.timeoutMs * numRuns) / defaults.runs),
  };
}

/** The property variables of the shell, as bindings, so a medium test reads them in workerd. */
export function propertyVars(): Record<string, string> {
  return Object.fromEntries(
    PROPERTY_VARS.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}
