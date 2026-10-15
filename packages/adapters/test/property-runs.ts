/** The variables that set the run count and seed of a property. */
const PROPERTY_VARS = ["PROPERTY_RUNS", "PROPERTY_SEED"] as const;

/**
 * The run count and seed of one property. `PROPERTY_RUNS` and `PROPERTY_SEED` override the
 * run count a pull request uses and a random seed. The seed is printed before the run starts,
 * so a run that hangs can be replayed.
 */
export function propertyRuns(property: string, runs: number): { numRuns: number; seed: number } {
  const numRuns = Number(process.env.PROPERTY_RUNS ?? runs);
  const seed = Number(process.env.PROPERTY_SEED ?? Math.floor(Math.random() * 2 ** 31));
  console.log(`${property}: PROPERTY_SEED=${seed}`);
  return { numRuns, seed };
}

/** A property's test timeout, grown in proportion when `PROPERTY_RUNS` raises its run count. */
export function propertyTimeoutMs(timeoutMs: number, runs: number): number {
  return Math.ceil((timeoutMs * Number(process.env.PROPERTY_RUNS ?? runs)) / runs);
}

/** The property variables of the shell as bindings, so a medium test reads them in workerd. */
export function propertyVars(): Record<string, string> {
  return Object.fromEntries(
    PROPERTY_VARS.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}
