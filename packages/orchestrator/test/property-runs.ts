/** How many runs a property makes: `PROPERTY_RUNS` when it is set, else `defaultRuns`. */
export function propertyRuns(defaultRuns: number): number {
  return Number(process.env.PROPERTY_RUNS ?? defaultRuns);
}

/**
 * The seed of a property run: `PROPERTY_SEED` when it is set, else a fresh one. It is printed
 * before the run starts, so a run that hangs can be replayed.
 */
export function propertySeed(property: string): number {
  const seed = Number(process.env.PROPERTY_SEED ?? Math.floor(Math.random() * 2 ** 31));
  console.log(`${property}: PROPERTY_SEED=${seed}`);
  return seed;
}
