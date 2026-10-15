const declaredCases = new Set<string>();

let coveredCases = new Set<string>();

/**
 * Declare a coverage case: a situation in which an invariant's check can fail. Returns the
 * marker the invariant calls when a step covers it.
 */
export function coverageCase(label: string): () => void {
  declaredCases.add(label);
  return () => {
    coveredCases.add(label);
  };
}

/** Every coverage case the loaded invariants declare. */
export function declaredCoverageCases(): string[] {
  return [...declaredCases];
}

/** The coverage cases marked since the last call. The next run starts with none. */
export function takeCoveredCases(): Set<string> {
  const taken = coveredCases;
  coveredCases = new Set();
  return taken;
}
