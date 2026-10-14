/**
 * The run count and seed of one property. `PROPERTY_RUNS` and `PROPERTY_SEED` override the
 * fast-check defaults. The seed is printed before the run starts, so a run that hangs can be
 * replayed.
 */
export function propertyRuns(property: string): { numRuns: number; seed: number } {
  const numRuns = Number(process.env.PROPERTY_RUNS ?? 100);
  const seed = Number(process.env.PROPERTY_SEED ?? Math.floor(Math.random() * 2 ** 31));
  console.log(`${property}: PROPERTY_SEED=${seed}`);
  return { numRuns, seed };
}
